// playercodec.js - byte reader/writer and the table-driven player record codec.
// Used for full world snapshots (sim.serialize) and for network delta snapshots.
export class Writer {
  constructor(cap = 256) { this.u = new Uint8Array(cap); this.v = new DataView(this.u.buffer); this.n = 0; }
  need(k) { if (this.n + k > this.u.length) { const u = new Uint8Array(Math.max(this.u.length * 2, this.n + k)); u.set(this.u); this.u = u; this.v = new DataView(u.buffer); } }
  u8(x) { this.need(1); this.v.setUint8(this.n, x); this.n += 1; }
  i8(x) { this.need(1); this.v.setInt8(this.n, x); this.n += 1; }
  u16(x) { this.need(2); this.v.setUint16(this.n, x, true); this.n += 2; }
  i16(x) { this.need(2); this.v.setInt16(this.n, x, true); this.n += 2; }
  u32(x) { this.need(4); this.v.setUint32(this.n, x >>> 0, true); this.n += 4; }
  i32(x) { this.need(4); this.v.setInt32(this.n, x, true); this.n += 4; }
  f32(x) { this.need(4); this.v.setFloat32(this.n, x, true); this.n += 4; }
  bytes() { return this.u.slice(0, this.n); }
}
export class Reader {
  constructor(u8, off = 0) { this.u = u8; this.v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.n = off; }
  u8() { const x = this.v.getUint8(this.n); this.n += 1; return x; }
  i8() { const x = this.v.getInt8(this.n); this.n += 1; return x; }
  u16() { const x = this.v.getUint16(this.n, true); this.n += 2; return x; }
  i16() { const x = this.v.getInt16(this.n, true); this.n += 2; return x; }
  u32() { const x = this.v.getUint32(this.n, true); this.n += 4; return x; }
  i32() { const x = this.v.getInt32(this.n, true); this.n += 4; return x; }
  f32() { const x = this.v.getFloat32(this.n, true); this.n += 4; return x; }
  get left() { return this.u.length - this.n; }
}

const num = k => ({ get: p => p[k], set: (p, v) => { p[k] = v; } });
const ammo = i => ({ get: p => p.ammo[i], set: (p, v) => { p.ammo[i] = v; } });
const flag = (bit) => ({ get: p => (p.alive ? 1 : 0) | (p.grounded ? 2 : 0), set: (p, v) => { p.alive = !!(v & 1); p.grounded = !!(v & 2); } });
// Order defines mask bits (max 32 fields).
export const PLAYER_FIELDS = [
  ['x', 'f32', num('x')], ['y', 'f32', num('y')], ['z', 'f32', num('z')],
  ['vx', 'f32', num('vx')], ['vy', 'f32', num('vy')], ['vz', 'f32', num('vz')],
  ['yaw', 'f32', num('yaw')], ['pitch', 'f32', num('pitch')],
  ['health', 'i16', num('health')], ['armor', 'i16', num('armor')], ['armorType', 'u8', num('armorType')],
  ['flags', 'u8', flag()], ['weapon', 'u8', num('weapon')], ['pendW', 'u8', num('pendW')],
  ['wstate', 'u8', num('wstate')], ['wtimer', 'u16', num('wtimer')], ['cooldown', 'u16', num('cooldown')],
  ['ammo0', 'u16', ammo(0)], ['ammo1', 'u16', ammo(1)], ['ammo2', 'u16', ammo(2)], ['ammo3', 'u16', ammo(3)],
  ['owned', 'u16', num('owned')], ['frags', 'i16', num('frags')], ['deaths', 'i16', num('deaths')],
  ['stepOff', 'f32', num('stepOff')], ['spawnProt', 'u16', num('spawnProt')], ['respawn', 'u16', num('respawn')],
  ['lastButtons', 'u8', num('lastButtons')], ['lastSeq', 'u32', num('lastSeq')],
].map(([name, type, acc]) => ({ name, type, get: acc.get, set: acc.set }));
if (PLAYER_FIELDS.length > 32) throw new Error('too many fields');

export const FULL_MASK = (PLAYER_FIELDS.length === 32 ? 0xffffffff : (1 << PLAYER_FIELDS.length) - 1) >>> 0;

export function newPlayer(id) {
  return { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, health: 100, armor: 0, armorType: 0,
    alive: true, grounded: true, weapon: 0, pendW: 0, wstate: 0, wtimer: 0, cooldown: 0, ammo: [0, 0, 0, 0], owned: 1,
    frags: 0, deaths: 0, stepOff: 0, spawnProt: 0, respawn: 0, lastButtons: 0, lastSeq: 0 };
}
export function clonePlayer(p) { return { ...p, ammo: p.ammo.slice() }; }

const fr = Math.fround;
export function fieldValue(f, p) { const v = f.get(p); return f.type === 'f32' ? fr(v) : v; }
export function playerMask(base, cur) {
  if (!base) return FULL_MASK;
  let m = 0;
  for (let i = 0; i < PLAYER_FIELDS.length; i++) if (fieldValue(PLAYER_FIELDS[i], base) !== fieldValue(PLAYER_FIELDS[i], cur)) m |= (1 << i);
  return m >>> 0;
}
function put(w, type, v) { w[type](v); }
export function writePlayer(w, base, cur, skip = 0) {
  const m = (playerMask(base, cur) & ~skip) >>> 0;
  w.u32(m);
  for (let i = 0; i < PLAYER_FIELDS.length; i++) if (m & (1 << i)) put(w, PLAYER_FIELDS[i].type, PLAYER_FIELDS[i].get(cur));
}
export function readPlayer(r, base, id) {
  const p = base ? clonePlayer(base) : newPlayer(id);
  const m = r.u32();
  for (let i = 0; i < PLAYER_FIELDS.length; i++) if (m & (1 << i)) PLAYER_FIELDS[i].set(p, r[PLAYER_FIELDS[i].type]());
  p.id = id;
  return p;
}
