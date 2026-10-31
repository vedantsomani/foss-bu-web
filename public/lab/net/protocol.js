// protocol.js - wire formats (all little-endian). Payloads ride inside the relay envelope.
import { Writer, Reader, writePlayer, readPlayer, PLAYER_FIELDS } from '../game/playercodec.js';

export const MSG = { HELLO: 1, WELCOME: 2, INPUT: 3, SNAPSHOT: 4, PING: 5, PONG: 6 };
export const TICK_MS = 1000 / 60;
export const REDUNDANCY = 3;

// fields not sent per-player in snapshots (carried in the header or client-only)
export const NET_SKIP = (1 << PLAYER_FIELDS.findIndex(f => f.name === 'lastSeq')) >>> 0;

// ---- input: seq u32, fwd i8, side i8, yaw u16, pitch i16 (1e-4 rad), buttons u8, weapon u8, viewTick u32  = 16 bytes
export function writeInput(w, i) {
  w.u32(i.seq); w.i8(Math.round(i.fwd * 127)); w.i8(Math.round(i.side * 127));
  w.u16(Math.round(i.yaw / (Math.PI * 2) * 65536) & 65535); w.i16(Math.round(i.pitch * 10000)); w.u8(i.buttons); w.u8(i.weapon); w.u32(i.viewTick);
}
export function readInput(r) {
  const seq = r.u32(), fwd = r.i8() / 127, side = r.i8() / 127, yaw = r.u16() / 65536 * Math.PI * 2, pitch = r.i16() / 10000;
  return { seq, fwd, side, yaw, pitch, buttons: r.u8(), weapon: r.u8(), viewTick: r.u32() };
}
export function encodeInputPacket(ackSnap, inputs) {
  const w = new Writer(8 + inputs.length * 16);
  w.u8(MSG.INPUT); w.u32(ackSnap); w.u8(inputs.length);
  for (const i of inputs) writeInput(w, i);
  return w.bytes();
}
export function decodeInputPacket(r) {
  const ackSnap = r.u32(), n = r.u8(), inputs = [];
  for (let k = 0; k < n; k++) inputs.push(readInput(r));
  return { ackSnap, inputs };
}

// ---- events
const EV = { fire: 1, hit: 2, kill: 3, pickup: 4, explode: 5, impact: 6, spawn: 7, jump: 8, land: 9, switch: 10, respawnitem: 11, teleport: 12, mover: 13, barrel: 14 };
const EVN = Object.fromEntries(Object.entries(EV).map(([k, v]) => [v, k]));
const u8 = v => (v === undefined || v < 0 ? 255 : v & 255);
const i16 = v => Math.max(-32768, Math.min(32767, Math.round(v || 0)));
export function writeEvent(w, e, snapTick, evTick) {
  w.u8(EV[e.t]); w.u8(Math.min(255, snapTick - evTick));
  let a = 255, b = 255, c = 0;
  switch (e.t) {
    case 'fire': a = u8(e.p); b = u8(e.w); break;
    case 'hit': a = u8(e.p); b = u8(e.target); c = e.dmg | 0; break;
    case 'kill': a = u8(e.killer); b = u8(e.victim); c = e.w | 0; break;
    case 'pickup': a = u8(e.p); c = e.idx; break;
    case 'explode': case 'impact': b = u8(e.w); break;
    case 'spawn': case 'jump': a = u8(e.p); break;
    case 'land': a = u8(e.p); c = Math.min(65535, e.v | 0); break;
    case 'switch': a = u8(e.p); b = u8(e.w); break;
    case 'respawnitem': case 'barrel': c = e.idx; break;
    case 'teleport': a = u8(e.p); b = e.out ? 1 : 0; c = (e.yaw | 0) & 0xffff; break;
    case 'mover': b = e.a & 255; c = e.s; break;
  }
  w.u8(a); w.u8(b); w.u16(c); w.i16(i16(e.x)); w.i16(i16(e.y)); w.i16(i16(e.z));
}
export function readEvent(r, snapTick) {
  const k = EVN[r.u8()], back = r.u8(), a = r.u8(), b = r.u8(), c = r.u16(), x = r.i16(), y = r.i16(), z = r.i16();
  const id = v => (v === 255 ? -1 : v);
  const e = { t: k, tick: snapTick - back, x, y, z };
  switch (k) {
    case 'fire': e.p = id(a); e.w = b; break;
    case 'hit': e.p = id(a); e.target = id(b); e.dmg = c; break;
    case 'kill': e.killer = id(a); e.victim = id(b); e.w = c; break;
    case 'pickup': e.p = id(a); e.idx = c; break;
    case 'explode': case 'impact': e.w = b; break;
    case 'spawn': case 'jump': e.p = id(a); break;
    case 'land': e.p = id(a); e.v = c; break;
    case 'switch': e.p = id(a); e.w = b; break;
    case 'respawnitem': case 'barrel': e.idx = c; break;
    case 'teleport': e.p = id(a); e.out = !!b; e.yaw = c; break;
    case 'mover': e.a = b; e.s = c; break;
  }
  return e;
}

// ---- snapshot
// header: type u8, tick u32, baseTick u32 (0 = full), ackSeq u32; players; removed; projectiles; pickups; events
// Sector state: Float32Array(nSec*6) tuples [floor, ceil, floorVel, ceilVel, floorTarget, ceilTarget]; only tuples that differ from the base are sent.
export const SEC_STRIDE = 6;
function writeSectors(w, cur, base) {
  const n = cur.length / SEC_STRIDE, idx = [];
  for (let i = 0; i < n; i++) { const o = i * SEC_STRIDE; for (let k = 0; k < SEC_STRIDE; k++) if (cur[o + k] !== base[o + k]) { idx.push(i); break; } }
  w.u16(idx.length);
  for (const i of idx) { w.u16(i); for (let k = 0; k < SEC_STRIDE; k++) w.f32(cur[i * SEC_STRIDE + k]); }
}
export function encodeSnapshot({ tick, baseTick, ackSeq, players, basePlayers, projectiles, pickupBits, pickupsChanged, events, sec, baseSec, switched }) {
  const w = new Writer(512);
  w.u8(MSG.SNAPSHOT); w.u32(tick); w.u32(baseTick); w.u32(ackSeq);
  const ids = Object.keys(players).map(Number).sort((a, b) => a - b);
  w.u8(ids.length);
  for (const id of ids) { w.u8(id); writePlayer(w, basePlayers ? basePlayers[id] : null, players[id], NET_SKIP); }
  const removed = basePlayers ? Object.keys(basePlayers).map(Number).filter(id => !players[id]) : [];
  w.u8(removed.length); for (const id of removed) w.u8(id);
  w.u8(Math.min(255, projectiles.length));
  for (const p of projectiles.slice(0, 255)) { w.u32(p.id); w.u8(p.owner); w.u8(p.w); w.f32(p.x); w.f32(p.y); w.f32(p.z); w.f32(p.vx); w.f32(p.vy); w.f32(p.vz); }
  w.u8(pickupsChanged ? 1 : 0);
  if (pickupsChanged) { w.u16(pickupBits.length); for (const b of pickupBits) w.u8(b); }
  const evs = events.slice(-120);
  w.u8(evs.length);
  for (const { tick: et, e } of evs) writeEvent(w, e, tick, et);
  if (sec) writeSectors(w, sec, baseSec);
  else w.u16(0);
  const sw = switched || []; w.u8(Math.min(255, sw.length)); for (let i = 0; i < Math.min(255, sw.length); i++) w.u16(sw[i]);
  return w.bytes();
}
// baseSecFor(tick) -> Float32Array state of that snapshot (or null); initSec = state for full snapshots (baseTick 0)
export function decodeSnapshot(r, basePlayersFor, baseSecFor, initSec) {
  const tick = r.u32(), baseTick = r.u32(), ackSeq = r.u32();
  const base = baseTick ? basePlayersFor(baseTick) : null;
  const baseSec = baseTick ? (baseSecFor ? baseSecFor(baseTick) : null) : initSec || null;
  if (baseTick && (!base || (initSec && !baseSec))) return { missingBase: true, tick, baseTick };
  const players = {};
  const n = r.u8();
  for (let i = 0; i < n; i++) { const id = r.u8(); players[id] = readPlayer(r, base ? base[id] : null, id); }
  const nr = r.u8(); const removed = []; for (let i = 0; i < nr; i++) removed.push(r.u8());
  // players not mentioned keep their baseline state
  if (base) for (const id of Object.keys(base)) if (!(id in players) && !removed.includes(+id)) players[id] = base[id];
  const projectiles = [];
  const np = r.u8();
  for (let i = 0; i < np; i++) projectiles.push({ id: r.u32(), owner: r.u8(), w: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32() });
  let pickupBits = null;
  if (r.u8()) { const len = r.u16(); pickupBits = []; for (let i = 0; i < len; i++) pickupBits.push(r.u8()); }
  const ne = r.u8(); const events = [];
  for (let i = 0; i < ne; i++) events.push(readEvent(r, tick));
  let sec = null;
  const nsc = r.u16();
  if (baseSec) { sec = baseSec.slice(); }
  for (let i = 0; i < nsc; i++) { const si = r.u16(); for (let k = 0; k < SEC_STRIDE; k++) { const v = r.f32(); if (sec) sec[si * SEC_STRIDE + k] = v; } }
  const nsw = r.u8(), switched = []; for (let i = 0; i < nsw; i++) switched.push(r.u16());
  return { tick, baseTick, ackSeq, players, projectiles, pickupBits, events, sec, switched };
}
export function packBits(arr) { const out = new Array(Math.ceil(arr.length / 8)).fill(0); arr.forEach((a, i) => { if (a) out[i >> 3] |= 1 << (i & 7); }); return out; }
export const unpackBit = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;
export { Writer, Reader };
