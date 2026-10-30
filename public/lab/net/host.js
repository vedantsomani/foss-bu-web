// host.js - authoritative host. Runs the sim at 60 Hz regardless of client behaviour (never waits for anyone).
import { createWorld, step, addPlayer, removePlayer, DT, quantizeInput, hashWorld } from '../game/sim.js';
import { clonePlayer } from '../game/playercodec.js';
import { MSG, TICK_MS, Reader, Writer, decodeInputPacket, encodeSnapshot, packBits } from './protocol.js';

const GAP_WAIT_TICKS = 4;      // a missing command is skipped (not waited for) after this many ticks
const PEER_TIMEOUT_MS = 10000;

const maxRewindDisabled = h => h.maxRewindTicks === 0;
export class GameHost {
  constructor({ map, endpoint, seed = 1, snapshotEvery = 2, maxRewindMs = 200, interpMs = 100, localId = 0, simOpts = {} }) {
    this.map = map; this.ep = endpoint; this.snapshotEvery = snapshotEvery;
    // cap = maxRewindMs of network/processing latency PLUS the client's interpolation window (which every client has by design)
    this.maxRewindTicks = Math.round(maxRewindMs / TICK_MS);
    this.interpTicks = Math.round(interpMs / TICK_MS);
    this.world = createWorld(map, seed, simOpts);
    this.peers = new Map();
    this.history = new Array(128).fill(null);
    this.evlog = [];
    this.acc = 0; this.last = null; this.now = 0;
    this.stats = { snapshots: 0, full: 0, bytesOut: 0, bytesIn: 0, skippedCommands: 0, lagCompUsed: 0 };
    this.onPacketHandler = (from, data) => this.onPacket(from, data);
    endpoint.onPacket = this.onPacketHandler;
    this.record();
    if (localId) this.addPeer(localId, true);
    if (endpoint.announce) endpoint.announce();
    this.localId = localId;
    this.simOpts = { lagComp: (id, inp) => this.lagComp(id, inp) };
  }
  addPeer(id, local = false) {
    let peer = this.peers.get(id);
    if (peer) return peer;
    peer = { id, local, queue: [], lastExec: 0, gap: 0, ackSnap: 0, sent: new Map(), prevSnapTick: 0, lastSnapTick: 0, lastHeard: this.now, localSeq: 0, depth: local ? 1 : 3, primed: false, quiet: 0, starved: 0 };
    this.peers.set(id, peer);
    if (!this.world.players[id]) addPlayer(this.world, id);
    return peer;
  }
  // host's own player: same command path as remote players, no network
  localInput(raw) {
    const peer = this.peers.get(this.localId);
    const cmd = quantizeInput({ ...raw, seq: ++peer.localSeq, viewTick: this.world.tick });
    peer.queue.push(cmd);
    return cmd;
  }
  onPacket(from, data) {
    this.stats.bytesIn += data.length;
    const r = new Reader(data);
    const type = r.u8();
    if (type === MSG.HELLO) {
      const peer = this.addPeer(from); peer.lastHeard = this.now;
      const w = new Writer(16); w.u8(MSG.WELCOME); w.u8(from); w.u32(this.world.tick); w.u8(this.snapshotEvery);
      this.ep.send(from, w.bytes());
    } else if (type === MSG.INPUT) {
      const peer = this.peers.get(from); if (!peer) return;
      peer.lastHeard = this.now;
      const { ackSnap, inputs } = decodeInputPacket(r);
      if (ackSnap > peer.ackSnap) peer.ackSnap = ackSnap;
      for (const i of inputs) {
        if (i.seq <= peer.lastExec || peer.queue.some(q => q.seq === i.seq)) continue;
        peer.queue.push(quantizeInput(i));
      }
      peer.queue.sort((a, b) => a.seq - b.seq);
      if (peer.queue.length > 60) peer.queue.splice(0, peer.queue.length - 30); // flooding guard
    } else if (type === MSG.PING) {
      const t = r.u32(); const w = new Writer(8); w.u8(MSG.PONG); w.u32(t); this.ep.send(from, w.bytes());
    }
  }
  update(nowMs) {
    this.now = nowMs;
    if (this.last === null) this.last = nowMs;
    this.acc += nowMs - this.last; this.last = nowMs;
    if (this.acc > TICK_MS * 6) this.acc = TICK_MS * 6; // after a stall do not spiral; the world just continues
    while (this.acc >= TICK_MS - 1e-6) { this.acc -= TICK_MS; this.tick(); }
  }
  // Input jitter buffer: commands are consumed at a steady 1/tick once `depth` of them are queued, so a remote
  // player's authoritative motion is smooth even when packets arrive unevenly. depth adapts (1..6) to starvation.
  takeCommands(peer) {
    const q = peer.queue;
    peer.quiet++;
    if (!peer.primed) { if (q.length < peer.depth) return null; peer.primed = true; }
    if (!q.length) { peer.primed = false; peer.starved++; peer.depth = Math.min(6, peer.depth + 1); peer.quiet = 0; return null; }
    if (peer.quiet > 600 && peer.depth > (peer.local ? 1 : 3)) { peer.depth--; peer.quiet = 0; }
    if (peer.lastExec && q[0].seq !== peer.lastExec + 1) {
      if (++peer.gap < GAP_WAIT_TICKS) return null; // maybe the missing command is in flight
      this.stats.skippedCommands += q[0].seq - peer.lastExec - 1;
    }
    peer.gap = 0;
    const n = q.length > peer.depth + 8 ? 3 : q.length > peer.depth + 3 ? 2 : 1; // catch up gently after a burst
    const out = [q.shift()];
    while (out.length < n && q.length && q[0].seq === out[out.length - 1].seq + 1) out.push(q.shift());
    peer.lastExec = out[out.length - 1].seq;
    return out;
  }
  tick() {
    const inputs = {};
    for (const peer of this.peers.values()) { const c = this.takeCommands(peer); if (c) inputs[peer.id] = c; }
    step(this.world, inputs, DT, this.simOpts);
    for (const e of this.world.events) this.evlog.push({ tick: this.world.tick, e });
    while (this.evlog.length && this.evlog[0].tick < this.world.tick - 90) this.evlog.shift();
    this.record();
    if (this.world.tick % this.snapshotEvery === 0) for (const peer of this.peers.values()) if (!peer.local) this.sendSnapshot(peer);
    for (const peer of [...this.peers.values()]) if (!peer.local && this.now - peer.lastHeard > PEER_TIMEOUT_MS) { this.peers.delete(peer.id); removePlayer(this.world, peer.id); }
  }
  record() {
    const pos = {};
    for (const id in this.world.players) { const p = this.world.players[id]; pos[id] = { x: p.x, y: p.y, z: p.z, alive: p.alive }; }
    this.history[this.world.tick & 127] = { tick: this.world.tick, pos };
  }
  // positions of all players as they were at tick `t` (rewound), or null
  posAt(t) { const h = this.history[t & 127]; return h && h.tick === t ? h.pos : null; }
  lagComp(shooterId, inp) {
    if (!inp.viewTick) return null;
    const peer = this.peers.get(shooterId);
    const cap = this.maxRewindTicks + (maxRewindDisabled(this) ? 0 : this.interpTicks + (peer ? peer.depth : 0));
    const back = Math.max(0, Math.min(cap, this.world.tick - inp.viewTick));
    if (back === 0) return null;
    const pos = this.posAt(this.world.tick - back);
    if (!pos) return null;
    this.stats.lagCompUsed++;
    const out = {};
    for (const id in pos) out[id] = pos[id].alive ? pos[id] : { x: 1e9, y: 1e9, z: 1e9 };
    return out;
  }
  sendSnapshot(peer) {
    const w = this.world, tick = w.tick;
    const base = peer.ackSnap && peer.sent.get(peer.ackSnap) ? peer.sent.get(peer.ackSnap) : null;
    const players = {};
    for (const id in w.players) players[id] = clonePlayer(w.players[id]);
    const bits = packBits(w.pickups.map(p => p.active));
    const changed = !base || base.bits.length !== bits.length || base.bits.some((b, i) => b !== bits[i]);
    const events = this.evlog.filter(x => x.tick > peer.prevSnapTick);
    const bytes = encodeSnapshot({ tick, baseTick: base ? peer.ackSnap : 0, ackSeq: peer.lastExec, players, basePlayers: base ? base.players : null,
      projectiles: w.projectiles, pickupBits: bits, pickupsChanged: changed, events });
    peer.sent.set(tick, { players, bits });
    for (const k of [...peer.sent.keys()]) if (k < peer.ackSnap) peer.sent.delete(k);
    while (peer.sent.size > 64) peer.sent.delete(peer.sent.keys().next().value);
    peer.prevSnapTick = peer.lastSnapTick; peer.lastSnapTick = tick;
    this.stats.snapshots++; if (!base) this.stats.full++; this.stats.bytesOut += bytes.length; this.stats.lastSnapBytes = bytes.length;
    this.ep.send(peer.id, bytes);
  }
  hash() { return hashWorld(this.world); }
}
