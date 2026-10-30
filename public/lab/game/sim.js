// sim.js - deterministic 60 Hz gameplay simulation. Plain-object state, no DOM, no wall-clock, no Math.random.
// Runs identically on the host, on clients (prediction) and in tests.
import { WEAPONS, AMMO_MAX, ITEMS, START_AMMO, RESPAWN_TICKS, RESPAWN_POWER } from './weapons.js';
import { Writer, Reader, PLAYER_FIELDS, newPlayer, clonePlayer, writePlayer, readPlayer } from './playercodec.js';

export const TICK_RATE = 60, DT = 1 / 60;
export const RADIUS = 16, HEIGHT = 56, EYE = 48, STEP_MAX = 24;
export const GRAVITY = 900, JUMP_V = 330, RUN_SPEED = 420, SPRINT_SPEED = 560;
export const GROUND_ACCEL = 12, GROUND_FRICTION = 9, AIR_ACCEL = 3, AIR_SPEED_CAP = 80;
export const BTN = { FIRE: 1, JUMP: 2, SPRINT: 4 };
export const SPAWN_PROT_TICKS = 180, RESPAWN_DELAY = 180;
export const WS = { READY: 0, LOWER: 1, RAISE: 2 };
const SWITCH_TICKS = 10;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------- PRNG (mulberry32, state in world.rng)
export function rand(world) {
  let t = (world.rng = (world.rng + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- map preparation (cached per MapData)
const prepCache = new WeakMap();
const CELL = 128;
export function prepareMap(map) {
  let prep = prepCache.get(map);
  if (prep) return prep;
  const side = i => (i === undefined || i === null || i < 0 || i === 65535 ? -1 : map.sidedefs[i].sector);
  const lines = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of map.vertices) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); }
  for (const ld of map.linedefs) {
    const a = map.vertices[ld.v1], b = map.vertices[ld.v2];
    const fs = side(ld.front), bs = side(ld.back);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    lines.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, dx, dy, len, fs, bs, impassable: fs < 0 || bs < 0 || (ld.flags & 1) !== 0, oneSided: fs < 0 || bs < 0 });
  }
  const gw = Math.max(1, Math.ceil((maxX - minX + 1) / CELL) + 1), gh = Math.max(1, Math.ceil((maxY - minY + 1) / CELL) + 1);
  const cells = new Array(gw * gh);
  lines.forEach((l, i) => {
    const x0 = Math.floor((Math.min(l.ax, l.bx) - minX) / CELL), x1 = Math.floor((Math.max(l.ax, l.bx) - minX) / CELL);
    const y0 = Math.floor((Math.min(l.ay, l.by) - minY) / CELL), y1 = Math.floor((Math.max(l.ay, l.by) - minY) / CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) (cells[cy * gw + cx] ||= []).push(i);
  });
  prep = { map, lines, cells, gw, gh, minX, minY, maxX, maxY, stamp: new Int32Array(lines.length), stampN: 0, pointInSector: null };
  prepCache.set(map, prep);
  return prep;
}
function nearbyLines(prep, x0, y0, x1, y1, out) {
  out.length = 0;
  const { gw, gh, minX, minY } = prep;
  const cx0 = Math.max(0, Math.floor((x0 - minX) / CELL)), cx1 = Math.min(gw - 1, Math.floor((x1 - minX) / CELL));
  const cy0 = Math.max(0, Math.floor((y0 - minY) / CELL)), cy1 = Math.min(gh - 1, Math.floor((y1 - minY) / CELL));
  const st = ++prep.stampN;
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const c = prep.cells[cy * gw + cx];
    if (!c) continue;
    for (let k = 0; k < c.length; k++) { const i = c[k]; if (prep.stamp[i] !== st) { prep.stamp[i] = st; out.push(i); } }
  }
  return out;
}
const _near = [];

function segDist2(l, px, py) {
  let t = l.len ? ((px - l.ax) * l.dx + (py - l.ay) * l.dy) / (l.len * l.len) : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = l.ax + l.dx * t, cy = l.ay + l.dy * t;
  return { d2: (px - cx) * (px - cx) + (py - cy) * (py - cy), cx, cy };
}
// Sector index containing (x,y). Nearest-linedef side test (exact BSP lookup can be injected via prep.pointInSector).
export function sectorAt(prep, x, y) {
  if (prep.pointInSector) return prep.pointInSector(x, y);
  let best = null, bd = Infinity;
  const consider = idxs => {
    for (const i of idxs) { const l = prep.lines[i]; const { d2 } = segDist2(l, x, y); if (d2 < bd) { bd = d2; best = l; } }
  };
  nearbyLines(prep, x - CELL, y - CELL, x + CELL, y + CELL, _near);
  consider(_near);
  if (!best || bd > CELL * CELL) { bd = Infinity; best = null; consider(prep.lines.keys()); }
  if (!best) return 0;
  const cross = best.dx * (y - best.ay) - best.dy * (x - best.ax);
  if (cross < 0) return best.fs >= 0 ? best.fs : best.bs;
  return best.bs >= 0 ? best.bs : best.fs;
}
export const floorAt = (prep, x, y) => prep.map.sectors[sectorAt(prep, x, y)].floor;
export const ceilAt = (prep, x, y) => prep.map.sectors[sectorAt(prep, x, y)].ceil;

// does a line block a walking player whose feet are at z?
function lineBlocksWalk(prep, l, z) {
  if (l.impassable) return true;
  const S = prep.map.sectors, f = S[l.fs], b = S[l.bs];
  const top = Math.min(f.ceil, b.ceil), bot = Math.max(f.floor, b.floor);
  return bot - z > STEP_MAX || top - Math.max(bot, z) < HEIGHT;
}

// Slide-move a circle: substeps no longer than 6 units, then iterative push-out (so no tunnelling).
export function moveCircle(prep, p, dx, dy) {
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / 6));
  const sx = dx / n, sy = dy / n;
  const x0 = p.x, y0 = p.y;
  let hit = false;
  for (let s = 0; s < n; s++) {
    p.x += sx; p.y += sy;
    for (let iter = 0; iter < 4; iter++) {
      let pushed = false;
      nearbyLines(prep, p.x - RADIUS - 1, p.y - RADIUS - 1, p.x + RADIUS + 1, p.y + RADIUS + 1, _near);
      for (let k = 0; k < _near.length; k++) {
        const l = prep.lines[_near[k]];
        const { d2, cx, cy } = segDist2(l, p.x, p.y);
        if (d2 >= RADIUS * RADIUS) continue;
        if (!lineBlocksWalk(prep, l, p.z)) continue;
        let nx, ny, d = Math.sqrt(d2);
        if (d > 1e-6) { nx = (p.x - cx) / d; ny = (p.y - cy) / d; }
        else { const sgn = l.dx * (p.y - l.ay) - l.dy * (p.x - l.ax) < 0 ? 1 : -1; nx = sgn * l.dy / l.len; ny = -sgn * l.dx / l.len; d = 0; }
        const push = RADIUS - d + 0.001;
        p.x += nx * push; p.y += ny * push; pushed = true; hit = true;
        // remove velocity into the wall
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
      }
      if (!pushed) break;
    }
  }
  // Safety net: soft constraints (step/ceiling lines) can be unsatisfiable inside a gap narrower than the player
  // (e.g. after jumping onto a thin ledge). Solid one-sided walls always win: never end a move on the far side of one.
  if (hit) {
    nearbyLines(prep, Math.min(x0, p.x) - 1, Math.min(y0, p.y) - 1, Math.max(x0, p.x) + 1, Math.max(y0, p.y) + 1, _near);
    for (let k = 0; k < _near.length; k++) {
      const l = prep.lines[_near[k]];
      if (!l.oneSided) continue;
      const o1 = l.dx * (y0 - l.ay) - l.dy * (x0 - l.ax), o2 = l.dx * (p.y - l.ay) - l.dy * (p.x - l.ax);
      if (o1 * o2 >= 0 && Math.abs(o2) > 1e-9) continue;
      const a = (p.x - x0) * (l.ay - y0) - (p.y - y0) * (l.ax - x0), b = (p.x - x0) * (l.by - y0) - (p.y - y0) * (l.bx - x0);
      if (a * b < 0 || Math.abs(o2) <= 1e-9) { p.x = x0; p.y = y0; p.vx = p.vy = 0; break; }
    }
  }
  return hit;
}

// ---------------------------------------------------------------- input helpers
export function makeInput(o = {}) {
  return { fwd: o.fwd || 0, side: o.side || 0, yaw: o.yaw || 0, pitch: o.pitch || 0, buttons: o.buttons || 0, weapon: o.weapon || 0, viewTick: o.viewTick || 0, seq: o.seq || 0 };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Canonical (wire-exact) form: both sides must simulate quantized inputs so prediction == authority.
export function quantizeInput(i) {
  const yawU = Math.round(((i.yaw % TWO_PI) + TWO_PI) % TWO_PI / TWO_PI * 65536) & 65535;
  return { fwd: Math.round(clamp(i.fwd || 0, -1, 1) * 127) / 127, side: Math.round(clamp(i.side || 0, -1, 1) * 127) / 127,
    yaw: yawU / 65536 * TWO_PI, pitch: Math.round(clamp(i.pitch || 0, -1.5, 1.5) * 10000) / 10000,
    buttons: (i.buttons || 0) & 255, weapon: (i.weapon || 0) & 255, viewTick: (i.viewTick || 0) >>> 0, seq: (i.seq || 0) >>> 0 };
}

// ---------------------------------------------------------------- player movement (pure on p + prep)
export function moveCommand(prep, p, inp, dt, events) {
  p.yaw = inp.yaw; p.pitch = clamp(inp.pitch, -1.5, 1.5);
  // view step smoothing decay
  if (p.stepOff > 0) p.stepOff = Math.max(0, p.stepOff - 140 * dt); else if (p.stepOff < 0) p.stepOff = Math.min(0, p.stepOff + 140 * dt);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  let wx = cy * inp.fwd + sy * inp.side, wy = sy * inp.fwd - cy * inp.side;
  let wl = Math.hypot(wx, wy);
  let wish = (inp.buttons & BTN.SPRINT ? SPRINT_SPEED : RUN_SPEED);
  if (wl > 1) { wx /= wl; wy /= wl; wl = 1; }
  if (wl > 1e-6) { wish *= wl; wx /= wl; wy /= wl; } else wish = 0;
  if (p.grounded) {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0) { const drop = Math.max(sp, 100) * GROUND_FRICTION * dt; const k = Math.max(0, sp - drop) / sp; p.vx *= k; p.vy *= k; }
    if (wish > 0) {
      const cur = p.vx * wx + p.vy * wy, add = wish - cur;
      if (add > 0) { const a = Math.min(GROUND_ACCEL * wish * dt, add); p.vx += wx * a; p.vy += wy * a; }
    }
    if (inp.buttons & BTN.JUMP) { p.vz = JUMP_V; p.grounded = false; events && events.push({ t: 'jump', p: p.id }); }
  } else if (wish > 0) {
    const ws = Math.min(wish, AIR_SPEED_CAP), cur = p.vx * wx + p.vy * wy, add = ws - cur;
    if (add > 0) { const a = Math.min(AIR_ACCEL * wish * dt, add); p.vx += wx * a; p.vy += wy * a; }
  }
  if (!p.grounded) p.vz -= GRAVITY * dt;
  // horizontal
  moveCircle(prep, p, p.vx * dt, p.vy * dt);
  // vertical
  const sec = prep.map.sectors[sectorAt(prep, p.x, p.y)];
  const fl = sec.floor, ce = sec.ceil;
  const wasGrounded = p.grounded;
  if (!wasGrounded) p.z += p.vz * dt;
  if (p.z < fl) {
    if (wasGrounded) p.stepOff -= fl - p.z; // stepped up a stair: snap physics, ease the camera
    else if (p.vz < -250) events && events.push({ t: 'land', p: p.id, v: -p.vz });
    p.z = fl; p.vz = 0; p.grounded = true;
  } else if (p.z > fl + 0.001) {
    if (wasGrounded && p.z - fl <= STEP_MAX) { p.stepOff += p.z - fl; p.z = fl; p.grounded = true; } // walk down stairs glued
    else p.grounded = false;
  } else p.grounded = true;
  if (p.z + HEIGHT > ce) { p.z = ce - HEIGHT; if (p.vz > 0) p.vz = 0; }
}

// ---------------------------------------------------------------- world
export function createWorld(map, seed = 1, opts = {}) {
  const prep = prepareMap(map);
  if (opts.pointInSector) prep.pointInSector = opts.pointInSector;
  const world = { map, prep, tick: 0, seed: seed >>> 0, rng: seed >>> 0, players: {}, projectiles: [], nextProj: 1, pickups: [], events: [], auth: true,
    spawns: [] };
  for (const t of map.things) if (t.type === 11) world.spawns.push({ x: t.x, y: t.y, angle: t.angle });
  if (!world.spawns.length) for (const t of map.things) if (t.type >= 1 && t.type <= 4) world.spawns.push({ x: t.x, y: t.y, angle: t.angle });
  if (!world.spawns.length) world.spawns.push({ x: (prep.minX + prep.maxX) / 2, y: (prep.minY + prep.maxY) / 2, angle: 0 });
  for (const t of map.things) {
    const it = ITEMS[t.type];
    if (!it) continue;
    world.pickups.push({ type: t.type, x: t.x, y: t.y, z: floorAt(prep, t.x, t.y), active: true, timer: 0 });
  }
  return world;
}
// lightweight world used by clients for prediction (no combat effects, shares map prep)
export function createPredictWorld(map) {
  return { map, prep: prepareMap(map), tick: 0, rng: 1, players: {}, projectiles: [], pickups: [], events: [], auth: false, spawns: [], nextProj: 1 };
}

export function addPlayer(world, id) {
  const p = newPlayer(id);
  p.ammo = START_AMMO.slice();
  world.players[id] = p;
  spawnPlayer(world, p);
  return p;
}
export function removePlayer(world, id) { delete world.players[id]; }
const sortedIds = w => Object.keys(w.players).map(Number).sort((a, b) => a - b);

export function spawnPlayer(world, p) {
  let best = -1, bs = -1;
  const others = Object.values(world.players).filter(o => o !== p && o.alive);
  const scores = world.spawns.map(s => {
    let m = Infinity;
    for (const o of others) m = Math.min(m, Math.hypot(o.x - s.x, o.y - s.y));
    return m;
  });
  for (let i = 0; i < scores.length; i++) if (scores[i] > bs) { bs = scores[i]; best = i; }
  if (bs === Infinity) best = Math.floor(rand(world) * world.spawns.length);
  const s = world.spawns[best];
  p.x = s.x; p.y = s.y; p.z = floorAt(world.prep, s.x, s.y); p.vx = p.vy = p.vz = 0; p.stepOff = 0;
  p.yaw = ((s.angle || 0) * Math.PI / 180 + TWO_PI) % TWO_PI; p.pitch = 0;
  p.health = 100; p.armor = 0; p.armorType = 0; p.alive = true; p.grounded = true;
  p.weapon = 0; p.pendW = 0; p.wstate = 0; p.wtimer = 0; p.cooldown = 0; p.owned = 1; p.ammo = START_AMMO.slice();
  p.spawnProt = SPAWN_PROT_TICKS; p.respawn = 0;
  world.events.push({ t: 'spawn', p: p.id, x: p.x, y: p.y, z: p.z });
}

// ---------------------------------------------------------------- ray tracing
// Returns {s, kind:'none'|'wall'|'player', target, x,y,z}. (dx,dy,dz) must be a unit vector.
// posFn(id) -> {x,y,z} gives (possibly rewound) player positions.
export function traceRay(world, ox, oy, oz, dx, dy, dz, range, shooterId, posFn, extraR = 0, skipId = -1) {
  const prep = world.prep, S = prep.map.sectors;
  let best = range, kind = 'none', target = -1;
  // walls
  for (let i = 0; i < prep.lines.length; i++) {
    const l = prep.lines[i];
    const den = dx * l.dy - dy * l.dx;
    if (Math.abs(den) < 1e-12) continue;
    const ax = l.ax - ox, ay = l.ay - oy;
    const s = (ax * l.dy - ay * l.dx) / den, u = (ax * dy - ay * dx) / den;
    if (s < -1e-4 || s > best || u < 0 || u > 1) continue;
    const z = oz + dz * s;
    if (l.oneSided) { best = s; kind = 'wall'; continue; }
    const f = S[l.fs], b = S[l.bs];
    if (z < Math.max(f.floor, b.floor) || z > Math.min(f.ceil, b.ceil)) { best = s; kind = 'wall'; }
  }
  // floor / ceiling of origin sector
  const sec = S[sectorAt(prep, ox, oy)];
  if (dz < -1e-9) { const s = (sec.floor - oz) / dz; if (s > 0 && s < best) { best = s; kind = 'wall'; } }
  else if (dz > 1e-9) { const s = (sec.ceil - oz) / dz; if (s > 0 && s < best) { best = s; kind = 'wall'; } }
  // players (vertical cylinders)
  const R = RADIUS + extraR;
  for (const id of sortedIds(world)) {
    const pl = world.players[id];
    if (id === shooterId || id === skipId || !pl.alive) continue;
    const pos = posFn ? posFn(id) : pl;
    if (!pos) continue;
    const hl2 = dx * dx + dy * dy, px = ox - pos.x, py = oy - pos.y;
    let s0, s1;
    if (hl2 < 1e-12) { if (px * px + py * py > R * R) continue; s0 = 0; s1 = Infinity; }
    else {
      const b = 2 * (dx * px + dy * py), c = px * px + py * py - R * R, disc = b * b - 4 * hl2 * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc); s0 = (-b - sq) / (2 * hl2); s1 = (-b + sq) / (2 * hl2);
    }
    let z0, z1;
    if (Math.abs(dz) < 1e-9) { if (oz < pos.z || oz > pos.z + HEIGHT) continue; z0 = -Infinity; z1 = Infinity; }
    else { z0 = (pos.z - oz) / dz; z1 = (pos.z + HEIGHT - oz) / dz; if (z0 > z1) { const t = z0; z0 = z1; z1 = t; } }
    const lo = Math.max(s0, z0, 0), hi = Math.min(s1, z1);
    if (lo <= hi && lo < best) { best = lo; kind = 'player'; target = id; }
  }
  return { s: best, kind, target, x: ox + dx * best, y: oy + dy * best, z: oz + dz * best };
}

// ---------------------------------------------------------------- damage
export function damagePlayer(world, victim, amount, attacker, weapon) {
  if (!victim.alive || amount <= 0) return 0;
  if (victim.spawnProt > 0) return 0;
  let saved = 0;
  if (victim.armor > 0) {
    saved = Math.floor(amount * (victim.armorType === 2 ? 0.5 : 1 / 3));
    if (saved > victim.armor) saved = victim.armor;
    victim.armor -= saved;
  }
  const taken = amount - saved;
  victim.health -= taken;
  if (victim.health <= 0) {
    victim.health = Math.min(victim.health, 0); victim.alive = false; victim.deaths++; victim.respawn = RESPAWN_DELAY;
    victim.vx = victim.vy = 0;
    const k = world.players[attacker];
    if (k) k.frags += (attacker === victim.id ? -1 : 1);
    world.events.push({ t: 'kill', killer: attacker, victim: victim.id, w: weapon });
  }
  return taken;
}
const rollDmg = (world, d) => d.base * (1 + Math.floor(rand(world) * d.mult));

function explode(world, proj, x, y, z, directTarget) {
  const def = WEAPONS[proj.w].proj;
  world.events.push({ t: 'explode', x, y, z, w: proj.w });
  if (def.splash <= 0) return;
  for (const id of sortedIds(world)) {
    const pl = world.players[id];
    if (!pl.alive) continue;
    const cx = pl.x, cy = pl.y, cz = pl.z + HEIGHT / 2;
    const dist = Math.hypot(x - cx, y - cy, z - cz);
    const d = Math.max(0, dist - RADIUS);
    if (d >= def.splashRadius) continue;
    const dmg = Math.floor(def.splash * (1 - d / def.splashRadius));
    if (dmg <= 0) continue;
    const taken = damagePlayer(world, pl, dmg, proj.owner, proj.w);
    world.events.push({ t: 'hit', p: proj.owner, target: id, dmg: taken, x: cx, y: cy, z: cz, w: proj.w, splash: 1 });
    // knockback
    const L = dist || 1, kb = Math.min(dmg * 4, 700);
    pl.vx += (cx - x) / L * kb; pl.vy += (cy - y) / L * kb;
    if (pl.grounded || true) { pl.vz += Math.max(0, (cz - z) / L) * kb * 0.6 + (dmg > 20 ? 60 : 0); if (pl.vz > 0) pl.grounded = false; }
  }
}

// ---------------------------------------------------------------- weapons
function ownsWeapon(p, w) { return (p.owned & (1 << w)) !== 0; }
function hasAmmo(p, w) { const d = WEAPONS[w]; return d.ammoType < 0 || p.ammo[d.ammoType] >= d.cost; }
export function bestWeapon(p) {
  let best = 0, bs = -1;
  for (const d of WEAPONS) if (ownsWeapon(p, d.id) && hasAmmo(p, d.id) && d.id !== 0 && d.slot > bs) { bs = d.slot; best = d.id; }
  return best;
}
function beginSwitch(p, w) { p.pendW = w; p.wstate = WS.LOWER; p.wtimer = SWITCH_TICKS; }

function weaponCommand(world, p, inp, opts) {
  const ev = world.events;
  if (p.cooldown > 0) p.cooldown--;
  if (p.wstate === WS.LOWER) {
    if (--p.wtimer <= 0) { p.weapon = p.pendW; p.wstate = WS.RAISE; p.wtimer = SWITCH_TICKS; ev.push({ t: 'switch', p: p.id, w: p.weapon }); }
  } else if (p.wstate === WS.RAISE) {
    if (--p.wtimer <= 0) { p.wstate = WS.READY; p.wtimer = 0; }
  } else if (inp.weapon > 0 && inp.weapon - 1 < WEAPONS.length && inp.weapon - 1 !== p.weapon && ownsWeapon(p, inp.weapon - 1)) {
    beginSwitch(p, inp.weapon - 1);
  }
  const fireDown = (inp.buttons & BTN.FIRE) !== 0, edge = fireDown && !(p.lastButtons & BTN.FIRE);
  const d = WEAPONS[p.weapon];
  if (p.wstate === WS.READY && p.cooldown === 0 && (d.auto ? fireDown : edge)) {
    if (hasAmmo(p, p.weapon)) shoot(world, p, inp, d, opts);
    else if (edge) { const b = bestWeapon(p); if (b !== p.weapon) beginSwitch(p, b); }
  }
  p.lastButtons = inp.buttons;
}

function shoot(world, p, inp, d, opts) {
  p.ammo[d.ammoType] -= d.cost;
  p.cooldown = d.cooldown;
  const ox = p.x, oy = p.y, oz = p.z + EYE;
  world.events.push({ t: 'fire', p: p.id, w: d.id, x: ox, y: oy, z: oz });
  if (!world.auth) return; // prediction world: only the local, deterministic consequences
  p.spawnProt = 0; // firing ends spawn protection
  const lag = opts && opts.lagComp ? opts.lagComp(p.id, inp) : null;
  const posFn = lag ? (id => lag[id] || world.players[id]) : null;
  const cosP = Math.cos(p.pitch), sinP = Math.sin(p.pitch);
  for (let i = 0; i < d.pellets; i++) {
    let yaw = p.yaw, pitch = p.pitch;
    if (d.spread) { yaw += (rand(world) * 2 - 1) * d.spread; pitch += (rand(world) * 2 - 1) * d.spread * 0.6; }
    const cp = Math.cos(pitch), dx = Math.cos(yaw) * cp, dy = Math.sin(yaw) * cp, dz = Math.sin(pitch);
    if (d.kind === 'hitscan') {
      const r = traceRay(world, ox, oy, oz, dx, dy, dz, d.range, p.id, posFn);
      if (r.kind === 'player') {
        const dmg = rollDmg(world, d.dmg), tg = world.players[r.target];
        const taken = damagePlayer(world, tg, dmg, p.id, d.id);
        world.events.push({ t: 'hit', p: p.id, target: r.target, dmg: taken, x: r.x, y: r.y, z: r.z, w: d.id });
      } else if (r.kind === 'wall') world.events.push({ t: 'impact', x: r.x - dx * 0.5, y: r.y - dy * 0.5, z: r.z - dz * 0.5, w: d.id });
    } else {
      const pd = d.proj;
      // spawn slightly ahead of the eye; abort into an immediate explosion if that crosses a wall
      const r = traceRay(world, ox, oy, oz, dx, dy, dz, 12, p.id, null, 0, -2);
      const pr = { id: world.nextProj++, owner: p.id, w: d.id, x: ox + dx * 12, y: oy + dy * 12, z: oz - 6 + dz * 12,
        vx: dx * pd.speed, vy: dy * pd.speed, vz: dz * pd.speed, ttl: pd.ttl, dmg: rollDmg(world, pd.dmg) };
      if (r.kind === 'wall') { pr.x = r.x - dx * 2; pr.y = r.y - dy * 2; pr.z = r.z - dz * 2; explode(world, pr, pr.x, pr.y, pr.z, -1); }
      else world.projectiles.push(pr);
    }
  }
}

function updateProjectiles(world, dt) {
  const keep = [];
  for (const pr of world.projectiles) {
    const def = WEAPONS[pr.w].proj;
    const sp = Math.hypot(pr.vx, pr.vy, pr.vz), dist = sp * dt;
    const dx = pr.vx / sp, dy = pr.vy / sp, dz = pr.vz / sp;
    const r = traceRay(world, pr.x, pr.y, pr.z, dx, dy, dz, dist, -1, null, def.radius, pr.owner);
    pr.ttl--;
    if (r.kind === 'none') {
      pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.z += pr.vz * dt;
      if (pr.ttl > 0) { keep.push(pr); continue; }
      explode(world, pr, pr.x, pr.y, pr.z, -1);
      continue;
    }
    const ex = r.x - dx * 1, ey = r.y - dy * 1, ez = r.z - dz * 1;
    if (r.kind === 'player') {
      const tg = world.players[r.target];
      const taken = damagePlayer(world, tg, pr.dmg, pr.owner, pr.w);
      world.events.push({ t: 'hit', p: pr.owner, target: r.target, dmg: taken, x: r.x, y: r.y, z: r.z, w: pr.w });
    }
    explode(world, pr, ex, ey, ez, r.target);
  }
  world.projectiles = keep;
}

// ---------------------------------------------------------------- pickups
function tryPickup(world, p, it) {
  let used = false;
  if (it.weapon !== undefined) {
    const d = WEAPONS[it.weapon], isNew = !ownsWeapon(p, it.weapon);
    const room = p.ammo[d.ammoType] < AMMO_MAX[d.ammoType];
    if (isNew || room) {
      p.owned |= 1 << it.weapon;
      p.ammo[d.ammoType] = Math.min(AMMO_MAX[d.ammoType], p.ammo[d.ammoType] + d.pickupAmmo);
      if (isNew && p.wstate === WS.READY) beginSwitch(p, it.weapon);
      used = true;
    }
  }
  if (it.ammo) { const [t, n] = it.ammo; if (p.ammo[t] < AMMO_MAX[t]) { p.ammo[t] = Math.min(AMMO_MAX[t], p.ammo[t] + n); used = true; } }
  if (it.health && p.health < it.max) { p.health = Math.min(it.max, p.health + it.health); used = true; }
  if (it.armorAdd && p.armor < it.max) { p.armor = Math.min(it.max, p.armor + it.armorAdd); if (!p.armorType) p.armorType = 1; used = true; }
  if (it.armorSet && p.armor < it.armorSet) { p.armor = it.armorSet; p.armorType = it.type; used = true; }
  return used;
}
function updatePickups(world) {
  world.pickups.forEach((pk, i) => {
    if (!pk.active) { if (--pk.timer <= 0) { pk.active = true; world.events.push({ t: 'respawnitem', idx: i, x: pk.x, y: pk.y, z: pk.z }); } return; }
    for (const id of sortedIds(world)) {
      const p = world.players[id];
      if (!p.alive || Math.abs(p.x - pk.x) > 30 || Math.abs(p.y - pk.y) > 30 || p.z > pk.z + 40 || p.z + HEIGHT < pk.z) continue;
      const it = ITEMS[pk.type];
      if (tryPickup(world, p, it)) {
        pk.active = false; pk.timer = it.power ? RESPAWN_POWER : RESPAWN_TICKS;
        world.events.push({ t: 'pickup', p: id, idx: i, type: pk.type });
        break;
      }
    }
  });
}

// ---------------------------------------------------------------- step
// inputs[id] may be one input, an array of inputs (executed in order, one dt each), or absent (player idle this tick).
export function runCommand(world, p, raw, dt, opts) {
  const inp = raw.fwd === undefined ? makeInput(raw) : raw;
  if (p.alive) {
    moveCommand(world.prep, p, inp, dt, world.events);
    weaponCommand(world, p, inp, opts);
  } else p.lastButtons = inp.buttons;
  if (inp.seq) p.lastSeq = inp.seq;
}
export function step(world, inputsByPlayer, dt = DT, opts = null) {
  world.events = [];
  for (const id of sortedIds(world)) {
    const p = world.players[id];
    const c = inputsByPlayer && inputsByPlayer[id];
    if (!c) continue;
    if (Array.isArray(c)) for (const i of c) runCommand(world, p, i, dt, opts);
    else runCommand(world, p, c, dt, opts);
  }
  for (const id of sortedIds(world)) {
    const p = world.players[id];
    if (p.spawnProt > 0) p.spawnProt--;
    if (!p.alive && p.respawn > 0 && --p.respawn === 0) spawnPlayer(world, p);
  }
  updateProjectiles(world, dt);
  updatePickups(world);
  world.tick++;
  return world;
}

// ---------------------------------------------------------------- snapshots
export function serialize(world) {
  const w = new Writer(1024);
  w.u32(0x464c4e31); w.u32(world.tick); w.u32(world.seed); w.u32(world.rng); w.u32(world.nextProj);
  const ids = sortedIds(world);
  w.u8(ids.length);
  for (const id of ids) { w.u8(id); writePlayer(w, null, world.players[id]); }
  w.u16(world.projectiles.length);
  for (const p of world.projectiles) { w.u32(p.id); w.u8(p.owner); w.u8(p.w); w.f32(p.x); w.f32(p.y); w.f32(p.z); w.f32(p.vx); w.f32(p.vy); w.f32(p.vz); w.u16(p.ttl); w.u16(p.dmg); }
  w.u16(world.pickups.length);
  for (const pk of world.pickups) { w.u8(pk.active ? 1 : 0); w.u16(pk.timer); }
  return w.bytes();
}
export function deserialize(bytes, map, opts = {}) {
  const world = createWorld(map, 1, opts);
  const r = new Reader(bytes);
  if (r.u32() !== 0x464c4e31) throw new Error('bad snapshot');
  world.tick = r.u32(); world.seed = r.u32(); world.rng = r.u32(); world.nextProj = r.u32();
  const n = r.u8();
  for (let i = 0; i < n; i++) { const id = r.u8(); world.players[id] = readPlayer(r, null, id); }
  const pc = r.u16();
  for (let i = 0; i < pc; i++) world.projectiles.push({ id: r.u32(), owner: r.u8(), w: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32(), ttl: r.u16(), dmg: r.u16() });
  const kc = r.u16();
  for (let i = 0; i < kc; i++) { const a = r.u8(), t = r.u16(); if (world.pickups[i]) { world.pickups[i].active = !!a; world.pickups[i].timer = t; } }
  return world;
}
export function hashWorld(world) {
  const b = serialize(world);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export { WEAPONS, newPlayer, clonePlayer };
