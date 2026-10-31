// session.js - adapters that give the game loop one interface over a hosted match (host plays locally, optional bots)
// and a joined match (GameClient prediction + interpolation).
//   update(now) alpha() local(alpha) remotes(alpha) drainEvents(cb) projectiles projAge(now) pickupActive(i) heights()
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import { MemoryNetwork } from '../net/transport.js';
import { TICK_MS } from '../net/protocol.js';
import * as S from '../game/sim.js';
import { ITEMS, WEAPONS } from '../game/weapons.js';
import { pointInSector } from '../wad.js';
import { BotManager } from './bots.js';

const NEUTRAL = { fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
const LOCAL_ONLY = { fire: 1, jump: 1, land: 1, switch: 1, teleport: 1 };   // the local player's own events come from prediction
const lerp = (a, b, t) => a + (b - a) * t;

// pickups exactly as the sim builds them (same order => same indices as the pickup bitmask)
export function makePickups(map) {
  const prep = S.prepareMap(map), out = [];
  for (const t of map.things) if (ITEMS[t.type]) out.push({ type: t.type, x: t.x, y: t.y, z: S.floorAt(prep, t.x, t.y) });
  return out;
}
const COPY = ['vx', 'vy', 'vz', 'yaw', 'pitch', 'alive', 'grounded', 'health', 'armor', 'armorType', 'weapon', 'pendW', 'wstate', 'wtimer', 'cooldown', 'owned', 'frags', 'deaths', 'respawn', 'spawnProt', 'stepOff'];
function fillState(out, p) {
  for (let i = 0; i < COPY.length; i++) out[COPY[i]] = p[COPY[i]];
  out.ammo = p.ammo; return out;
}

class Base {
  constructor(map) { this.map = map; this.pickups = makePickups(map); this.lv = {}; this.rv = {}; this.myId = 1; this.sampler = null; this.sOut = { fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 }; }
  get world() { return this.host ? this.host.world : this.client.pw; }
  // Render-ready missiles: [{id,w,x,y,z,vx,vy,vz,own}], positions shown at the same instant as interpolated players and never drawn
  // through geometry (a missile that is about to hit stops at the surface; the explosion event follows).
  renderProjectiles(now, alpha) {
    const out = this._rp || (this._rp = []), pool = this._rpool || (this._rpool = []); let n = 0;
    const w = this.world, push = (src, age, own) => {
      const o = pool[n] || (pool[n] = { id: 0, w: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, own: false });
      o.id = src.id; o.w = src.w; o.vx = src.vx; o.vy = src.vy; o.vz = src.vz; o.own = own;
      let dx = src.vx * age, dy = src.vy * age, dz = src.vz * age;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 0.5 && age > 0) {
        const r = S.traceRay(w, src.x, src.y, src.z, dx / dist, dy / dist, dz / dist, dist, -1, null, 0, src.owner === undefined ? -1 : src.owner);
        if (r.kind !== 'none' && r.kind !== 'player') { const k = Math.max(0, r.s - 2) / dist; dx *= k; dy *= k; dz *= k; }
      }
      o.x = src.x + dx; o.y = src.y + dy; o.z = src.z + dz; out[n++] = o;
    };
    const base = this.projAge(now, alpha);
    const list = this.projectiles;
    for (let i = 0; i < list.length; i++) push(list[i], base, list[i].owner === this.myId);
    if (this.predicted) for (let i = 0; i < this.predicted.length; i++) { const q = this.predicted[i]; push(q, (now - q.t0) / 1000, true); }
    out.length = n; return out;
  }
  heights() {
    const o = this.host || this.client, w = this.host && this.host.world;
    const f = o.sectorHeights ? o.sectorHeights.bind(o) : (w && w.sectorHeights ? w.sectorHeights.bind(w) : null);
    return f ? f() : null;
  }
}

export class HostSession extends Base {
  // transport: relay endpoint (uid 1) or null for a solo practice match. humans: remote uids already in the lobby.
  constructor({ map, transport = null, humans = [], bots = 0, skill = 0.55, seed = (Math.random() * 2 ** 31) | 0, rules = 'classic' }) {
    super(map); this.kind = 'host'; this.myId = 1; this.solo = !transport; this.rules = rules;
    const ep = transport || new MemoryNetwork().endpoint(1);
    const host = this.host = new GameHost({ map, endpoint: ep, seed, localId: 1, simOpts: { pointInSector: (x, y) => pointInSector(map, x, y), rules } });
    for (const id of humans) host.addPeer(id);
    this.names = {}; this.botIds = [];
    if (bots > 0) {
      for (let id = 2; this.botIds.length < bots && id < 16; id++) if (!humans.includes(id)) this.botIds.push(id);
      this.bots = new BotManager(host, { ids: this.botIds, skill });
      Object.assign(this.names, this.bots.names);
    }
    this.pc = {}; this.evq = []; this.paused = false;
    const orig = host.tick.bind(host);
    host.tick = () => {
      if (this.bots) this.bots.think();
      host.localInput(this.sampler ? this.sampler(host.world.players[1], this.sOut) : NEUTRAL);
      orig();
      this.afterTick();
    };
    this.afterTick();
  }
  afterTick() {
    const w = this.host.world;
    for (const id in w.players) {
      const p = w.players[id]; let c = this.pc[id];
      if (!c) c = this.pc[id] = { px: p.x, py: p.y, pz: p.z, x: p.x, y: p.y, z: p.z, alive: p.alive };
      c.px = c.x; c.py = c.y; c.pz = c.z;
      c.x = p.x; c.y = p.y; c.z = p.z;
      if (c.alive !== p.alive || Math.abs(c.x - c.px) + Math.abs(c.y - c.py) > 200) { c.px = c.x; c.py = c.y; c.pz = c.z; }
      c.alive = p.alive;
    }
    for (const id in this.pc) if (!w.players[id]) delete this.pc[id];
    for (const e of w.events) this.evq.push(e);
    this.projectiles = w.projectiles;
  }
  get tick() { return this.host.world.tick; }
  get ready() { return true; }
  pause(v) { if (v === this.paused) return; this.paused = v; if (!v) this.host.last = null; }
  update(now) { if (!this.paused) this.host.update(now); }
  alpha() { return this.paused ? (this.lastAlpha || 0) : (this.lastAlpha = Math.min(1, this.host.acc / TICK_MS)); }
  projAge(now, alpha) { return (alpha - 1) * S.DT; }   // players are drawn one tick behind the sim (interpolated): so are missiles
  pickupActive(i) { return this.host.world.pickups[i].active; }
  local(alpha) {
    const p = this.host.world.players[1], c = this.pc[1]; if (!p) return null;
    const o = fillState(this.lv, p);
    o.x = lerp(c.px, c.x, alpha); o.y = lerp(c.py, c.y, alpha); o.z = lerp(c.pz, c.z, alpha);
    o.eyeZ = o.z + S.eyeOf(this.host.world) + p.stepOff; return o;
  }
  remotes(alpha) {
    const w = this.host.world, rv = this.rv;
    for (const id in rv) if (!w.players[id]) delete rv[id];
    for (const id in w.players) {
      if (+id === 1) continue;
      const p = w.players[id], c = this.pc[id]; if (!c) continue;
      const o = rv[id] || (rv[id] = {});
      fillState(o, p); o.x = lerp(c.px, c.x, alpha); o.y = lerp(c.py, c.y, alpha); o.z = lerp(c.pz, c.z, alpha);
    }
    return rv;
  }
  drainEvents(cb) {
    const q = this.evq;
    for (let i = 0; i < q.length; i++) { const e = q[i]; cb(e, e.p === 1 && LOCAL_ONLY[e.t] === 1); }
    q.length = 0;
  }
  get rtt() { return 0; }
  get stalled() { return false; }
}

export class ClientSession extends Base {
  constructor({ map, transport, id, rules = 'classic' }) {
    super(map); this.kind = 'client'; this.myId = id; this.names = {}; this.rules = rules; this.predicted = []; this.seenProj = 0;
    const c = this.client = new GameClient({ map, endpoint: transport, id, inputSource: () => this.sampler ? this.sampler(c.me, this.sOut) : NEUTRAL, rules });
    S.prepareMap(map).pointInSector = (x, y) => pointInSector(map, x, y);   // same sector lookup as the authority
    this.prevV = null; this.curV = null; this.lastProjs = null; this.projT = 0; this.lastSnapAt = 0; this.lastSnapN = 0;
    const orig = c.tick.bind(c);
    c.tick = () => { orig(); if (c.me) { const v = c.localView(); this.prevV = this.curV || v; this.curV = v; } };
    this.projectiles = c.projectiles;
  }
  get tick() { return this.client.lastSnapTick; }
  get ready() { return !!this.client.me; }
  update(now) {
    this.now = now; this.client.update(now);
    if (this.client.projectiles !== this.lastProjs) {
      this.lastProjs = this.projectiles = this.client.projectiles; this.projT = now;
      // the host's version of my own rockets has arrived: retire the predicted ones it replaces
      let top = this.seenProj;
      for (const pr of this.projectiles) if (pr.id > this.seenProj) { top = Math.max(top, pr.id); if (pr.owner === this.myId && this.predicted.length) this.predicted.shift(); }
      this.seenProj = top;
    }
    const pq = this.predicted;
    if (pq.length) {   // predicted rockets stop at geometry (the host's explosion event does the rest) and expire
      const w = this.client.pw;
      for (let i = pq.length - 1; i >= 0; i--) {
        const q = pq[i], age = (now - q.t0) / 1000, sp = Math.hypot(q.vx, q.vy, q.vz);
        const r = age > 0.02 ? S.traceRay(w, q.x, q.y, q.z, q.vx / sp, q.vy / sp, q.vz / sp, sp * age, -1, null, 0, this.myId) : null;
        if (age > 2.5 || (r && r.kind !== 'none' && r.kind !== 'player')) pq.splice(i, 1);
      }
    }
    if (this.client.stats.snapshots !== this.lastSnapN) { this.lastSnapN = this.client.stats.snapshots; this.lastSnapAt = now; }
  }
  alpha() { return Math.min(1, this.client.acc / TICK_MS); }
  projAge(now) { return Math.min(0.12, (now - this.projT) / 1000); }
  pickupActive(i) { return this.client.pickupActive(i); }
  local(alpha) {
    const m = this.client.me, a = this.prevV, b = this.curV; if (!m || !a) return null;
    const o = fillState(this.lv, m);
    o.x = lerp(a.x, b.x, alpha); o.y = lerp(a.y, b.y, alpha); o.z = lerp(a.z, b.z, alpha); o.eyeZ = lerp(a.eyeZ, b.eyeZ, alpha);
    return o;
  }
  remotes() { return this.client.remotePlayers(); }
  // local fire events come from prediction: show my own rocket at once instead of one round trip later
  predictShot(e) {
    const d = WEAPONS[e.w], m = this.client.me; if (!d || d.kind !== 'projectile' || !m) return;
    const pd = this.client.pw.wpn[e.w].proj, cp = Math.cos(m.pitch), dx = Math.cos(m.yaw) * cp, dy = Math.sin(m.yaw) * cp, dz = Math.sin(m.pitch);
    const r = S.traceRay(this.client.pw, e.x, e.y, e.z, dx, dy, dz, 12, this.myId, null, 0, -2);
    if (r.kind !== 'none') return;
    this.predicted.push({ id: -1 - this.predicted.length, owner: this.myId, w: e.w, x: e.x + dx * 12, y: e.y + dy * 12, z: e.z - 8 + dz * 12, vx: dx * pd.speed, vy: dy * pd.speed, vz: dz * pd.speed, t0: this.now || performance.now() });
    if (this.predicted.length > 6) this.predicted.shift();
  }
  drainEvents(cb) {
    for (const e of this.client.drainLocalEvents()) { if (e.t === 'fire') this.predictShot(e); cb(e, true); }
    for (const e of this.client.drainEvents()) cb(e, e.p === this.myId && LOCAL_ONLY[e.t] === 1 ? 'dup' : false);
  }
  get rtt() { return this.client.stats.rtt; }
  get stalled() { return this.lastSnapAt > 0 && this.now - this.lastSnapAt > 6000; }
}
