// client.js - prediction + reconciliation for the local player, interpolation for everyone else.
import { createPredictWorld, runCommand, quantizeInput, DT, EYE } from '../game/sim.js';
import { clonePlayer } from '../game/playercodec.js';
import { MSG, TICK_MS, REDUNDANCY, Reader, Writer, encodeInputPacket, decodeSnapshot, unpackBit } from './protocol.js';
import { Interpolator } from './interp.js';

export class GameClient {
  // inputSource(): () => {fwd,side,yaw,pitch,buttons,weapon}, polled once per 60 Hz client tick
  constructor({ map, endpoint, hostId = 1, id, interpMs = 100, inputSource = () => ({}), redundancy = REDUNDANCY }) {
    this.map = map; this.ep = endpoint; this.hostId = hostId; this.id = id; this.interpTicks = interpMs / TICK_MS;
    this.inputSource = inputSource; this.redundancy = redundancy;
    this.pw = createPredictWorld(map);
    this.me = null; this.auth = null;           // predicted + last authoritative local player
    this.pending = []; this.seq = 0; this.localTick = 0;
    this.interp = new Interpolator();
    this.snapStates = new Map(); this.lastSnapTick = 0; this.ackedSnap = 0;
    this.renderTick = 0; this.offset = null; this.t0 = null; this.last = null; this.acc = 0; this.now = 0;
    this.offsetX = 0; this.offsetY = 0; this.offsetZ = 0; // visual smoothing of corrections
    this.projectiles = []; this.pickupBits = null; this.events = []; this.lastEventTick = 0; this.localEvents = [];
    this.welcomed = false; this.lastHello = -1e9; this.lastPing = -1e9;
    this.stats = { snapshots: 0, corrections: 0, lastCorrection: 0, maxCorrection: 0, rtt: 0, bytesIn: 0, bytesOut: 0, missingBase: 0 };
    endpoint.onPacket = (from, data) => this.onPacket(from, data);
  }
  onPacket(from, data) {
    this.stats.bytesIn += data.length;
    const r = new Reader(data); const type = r.u8();
    if (type === MSG.WELCOME) { this.welcomed = true; r.u8(); }
    else if (type === MSG.SNAPSHOT) this.onSnapshot(decodeSnapshot(r, t => this.snapStates.get(t)));
    else if (type === MSG.PONG) this.stats.rtt = this.now - r.u32();
  }
  get ready() { return !!this.me; }
  onSnapshot(s) {
    if (s.missingBase) { this.stats.missingBase++; return; }
    if (s.tick <= this.lastSnapTick) return;
    this.stats.snapshots++;
    this.lastSnapTick = s.tick; this.ackedSnap = s.tick;
    this.snapStates.set(s.tick, s.players);
    for (const k of this.snapStates.keys()) if (k < s.tick - 64) this.snapStates.delete(k);
    const remote = {};
    for (const k in s.players) if (+k !== this.id) remote[k] = s.players[k];
    this.interp.push(s.tick, remote);
    this.projectiles = s.projectiles; if (s.pickupBits) this.pickupBits = s.pickupBits;
    for (const e of s.events) if (e.tick > this.lastEventTick) this.events.push(e);
    this.lastEventTick = Math.max(this.lastEventTick, s.tick);
    // render clock: EMA of (server tick - local time in ticks)
    const nowTicks = this.t0 === null ? 0 : (this.now - this.t0) / TICK_MS;
    const sample = s.tick - nowTicks;
    this.offset = this.offset === null ? sample : this.offset + (sample - this.offset) * 0.05;
    if (this.renderTick === 0) this.renderTick = nowTicks + this.offset - this.interpTicks;
    const auth = s.players[this.id];
    if (auth) this.reconcile(auth, s.ackSeq);
  }
  reconcile(auth, ackSeq) {
    this.auth = auth;
    const m = clonePlayer(auth); m.lastSeq = ackSeq;
    this.pending = this.pending.filter(c => c.seq > ackSeq);
    const old = this.me;
    this.pw.events = [];
    for (const c of this.pending) runCommand(this.pw, m, c, DT);
    this.pw.events = [];
    if (old) {
      const err = Math.hypot(m.x - old.x, m.y - old.y, m.z - old.z);
      this.stats.lastCorrection = err;
      if (err > 0.01) { this.stats.corrections++; this.stats.maxCorrection = Math.max(this.stats.maxCorrection, err); }
      if (err < 64) { this.offsetX += old.x - m.x; this.offsetY += old.y - m.y; this.offsetZ += old.z - m.z; } else this.offsetX = this.offsetY = this.offsetZ = 0;
    }
    this.me = m;
  }
  update(nowMs) {
    this.now = nowMs;
    if (this.t0 === null) { this.t0 = nowMs; this.last = nowMs; }
    this.acc += nowMs - this.last; const dtMs = nowMs - this.last; this.last = nowMs;
    if (!this.welcomed && nowMs - this.lastHello > 250) { this.lastHello = nowMs; this.send(new Uint8Array([MSG.HELLO])); }
    if (nowMs - this.lastPing > 1000) { this.lastPing = nowMs; const w = new Writer(8); w.u8(MSG.PING); w.u32(nowMs); this.send(w.bytes()); }
    // render clock slews toward target; never jumps unless far off
    if (this.offset !== null) {
      const nowTicks = (nowMs - this.t0) / TICK_MS, target = nowTicks + this.offset - this.interpTicks;
      this.renderTick += dtMs / TICK_MS;
      const err = target - this.renderTick, dt = dtMs / TICK_MS;
      if (Math.abs(err) > 15) this.renderTick = target;
      else this.renderTick += Math.max(-0.25 * dt, Math.min(0.25 * dt, err * 0.1 * dt));
    }
    if (this.acc > TICK_MS * 6) this.acc = TICK_MS * 6;
    while (this.acc >= TICK_MS - 1e-6) { this.acc -= TICK_MS; this.tick(); }
  }
  tick() {
    this.localTick++;
    const k = 0.85; this.offsetX *= k; this.offsetY *= k; this.offsetZ *= k;
    if (!this.me) return;
    const raw = this.inputSource();
    const cmd = quantizeInput({ ...raw, seq: ++this.seq, viewTick: Math.round(this.renderTick) });
    this.pw.events = [];
    runCommand(this.pw, this.me, cmd, DT);
    for (const e of this.pw.events) this.localEvents.push(e);
    this.pending.push(cmd);
    if (this.pending.length > 240) this.pending.shift();
    this.send(encodeInputPacket(this.ackedSnap, this.pending.slice(-this.redundancy)));
  }
  send(bytes) { this.stats.bytesOut += bytes.length; this.ep.send(this.hostId, bytes); }
  // remote players at the interpolated render time
  remotePlayers() { return this.interp.sample(this.renderTick); }
  // local view with correction smoothing applied
  localView() {
    const m = this.me; if (!m) return null;
    return { ...m, x: m.x + this.offsetX, y: m.y + this.offsetY, z: m.z + this.offsetZ, eyeZ: m.z + this.offsetZ + EYE + m.stepOff };
  }
  pickupActive(i) { return this.pickupBits ? !!unpackBit(this.pickupBits, i) : true; }
  drainEvents() { const e = this.events; this.events = []; return e; }
  drainLocalEvents() { const e = this.localEvents; this.localEvents = []; return e; }
}
