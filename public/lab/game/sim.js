// sim.js - deterministic 60 Hz gameplay simulation. Plain-object state, no DOM, no wall-clock, no Math.random.
// Runs identically on the host, on clients (prediction) and in tests.
import { WEAPONS, AMMO_MAX, ITEMS, START_AMMO, RESPAWN_TICKS, RESPAWN_POWER } from './weapons.js';
import { getRules, weaponTable, doomSpeed, DOOM_TIC } from './rules.js';
import { Writer, Reader, PLAYER_FIELDS, newPlayer, clonePlayer, writePlayer, readPlayer } from './playercodec.js';

export const TICK_RATE = 60, DT = 1 / 60;
export const RADIUS = 16, HEIGHT = 56, EYE = 48, STEP_MAX = 24;
export const GRAVITY = 900, JUMP_V = 330, RUN_SPEED = 420, SPRINT_SPEED = 560;
export const GROUND_ACCEL = 12, GROUND_FRICTION = 9, AIR_ACCEL = 3, AIR_SPEED_CAP = 80;
export const BTN = { FIRE: 1, JUMP: 2, SPRINT: 4, USE: 8, AUTOAIM: 16 };
export const SPAWN_PROT_TICKS = 180, RESPAWN_DELAY = 180;
export const WS = { READY: 0, LOWER: 1, RAISE: 2 };
const SWITCH_TICKS = 10, STEP_SMOOTH = 6;
const TWO_PI = Math.PI * 2;
const MODERN_RULES = getRules('modern');
export const eyeOf = world => ((world && world.rules) || MODERN_RULES).eye;

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
    const isSw = n => /^SW[12]/.test(n || '');
    const sd0 = fs >= 0 ? map.sidedefs[ld.front] : null;
    lines.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, dx, dy, len, fs, bs, impassable: fs < 0 || bs < 0 || (ld.flags & 1) !== 0, oneSided: fs < 0 || bs < 0,
      special: ld.special | 0, tag: ld.tag | 0, sw: !!sd0 && (isSw(sd0.upper) || isSw(sd0.lower) || isSw(sd0.middle)) });
  }
  const gw = Math.max(1, Math.ceil((maxX - minX + 1) / CELL) + 1), gh = Math.max(1, Math.ceil((maxY - minY + 1) / CELL) + 1);
  const cells = new Array(gw * gh);
  lines.forEach((l, i) => {
    const x0 = Math.floor((Math.min(l.ax, l.bx) - minX) / CELL), x1 = Math.floor((Math.max(l.ax, l.bx) - minX) / CELL);
    const y0 = Math.floor((Math.min(l.ay, l.by) - minY) / CELL), y1 = Math.floor((Math.max(l.ay, l.by) - minY) / CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) (cells[cy * gw + cx] ||= []).push(i);
  });
  const nSec = map.sectors.length;
  const secLines = Array.from({ length: nSec }, () => []), tagSectors = new Map();
  lines.forEach((l, i) => { if (l.fs >= 0) secLines[l.fs].push(i); if (l.bs >= 0 && l.bs !== l.fs) secLines[l.bs].push(i); });
  map.sectors.forEach((sc, i) => { if (sc.tag) { if (!tagSectors.has(sc.tag)) tagSectors.set(sc.tag, []); tagSectors.get(sc.tag).push(i); } });
  const secCx = new Float32Array(nSec), secCy = new Float32Array(nSec);
  secLines.forEach((ls, i) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const li of ls) { const l = lines[li]; x0 = Math.min(x0, l.ax, l.bx); x1 = Math.max(x1, l.ax, l.bx); y0 = Math.min(y0, l.ay, l.by); y1 = Math.max(y1, l.ay, l.by); } secCx[i] = ls.length ? (x0 + x1) / 2 : 0; secCy[i] = ls.length ? (y0 + y1) / 2 : 0; });
  const gunLines = []; lines.forEach((l, i) => { if (l.special && SPECIALS[l.special] && SPECIALS[l.special].trig === 'G') gunLines.push(i); });
  prep = { map, lines, cells, gw, gh, minX, minY, maxX, maxY, stamp: new Int32Array(lines.length), stampN: 0, pointInSector: null,
    baseFloor: Float32Array.from(map.sectors, sc => sc.floor), baseCeil: Float32Array.from(map.sectors, sc => sc.ceil),
    nSec, secLines, tagSectors, secCx, secCy, gunLines, sky: Uint8Array.from(map.sectors, sc => (/^F_SKY/i.test(sc.ceilTex || '') ? 1 : 0)), hasSpecials: lines.some(l => l.special && SPECIALS[l.special]), tele: null };
  // exact BSP point location when the map carries nodes (otherwise the nearest-linedef fallback below is used)
  if (map.nodes && map.nodes.length && map.subsectors && map.subsectors.length && map.segs && map.segs.length) {
    const { nodes, subsectors, segs, linedefs, sidedefs } = map;
    prep.pointInSector = (x, y) => {
      let child = nodes.length - 1;
      while (!(child & 0x8000)) { const n = nodes[child]; child = (n.dx * (y - n.y) - n.dy * (x - n.x)) < 0 ? n.right : n.left; }
      const seg = segs[subsectors[child === 0xffff ? 0 : child & 0x7fff].first];
      if (!seg) return 0;
      const ld = linedefs[seg.linedef], sd = seg.side ? ld.back : ld.front;
      return sd >= 0 ? sidedefs[sd].sector : 0;
    };
  }
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
export const floorAt = (prep, x, y, F = prep.baseFloor) => F[sectorAt(prep, x, y)];
export const ceilAt = (prep, x, y, C = prep.baseCeil) => C[sectorAt(prep, x, y)];

// does a line block a walking player whose feet are at z?
function lineBlocksWalk(l, z, F, C) {
  if (l.impassable) return true;
  const top = Math.min(C[l.fs], C[l.bs]), bot = Math.max(F[l.fs], F[l.bs]);
  return bot - z > STEP_MAX || top - Math.max(bot, z) < HEIGHT;
}

// Slide-move a circle: substeps no longer than 6 units, then iterative push-out (so no tunnelling).
export function moveCircle(prep, p, dx, dy, F = prep.baseFloor, C = prep.baseCeil) {
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
        if (!lineBlocksWalk(l, p.z, F, C)) continue;
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
export function moveCommand(prep, p, inp, dt, events, W) {
  const F = W ? W.sectorFloor : prep.baseFloor, C = W ? W.sectorCeil : prep.baseCeil;
  const R = (W && W.rules) || MODERN_RULES;
  p.yaw = inp.yaw; p.pitch = clamp(inp.pitch, -1.5, 1.5);
  // view step smoothing decay
  if (p.stepOff > 0) p.stepOff = Math.max(0, p.stepOff - 140 * dt); else if (p.stepOff < 0) p.stepOff = Math.min(0, p.stepOff + 140 * dt);
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  if (R.move === 'doom') {
    // vanilla: every tic thrust (cmd * 2048/65536) is added to the momentum, then momentum *= 0xE800/0x10000 (ground only).
    // Converted to continuous time: velocity relaxes toward the steady-state speed of the command with the same time constant.
    const run = (inp.buttons & BTN.SPRINT) !== 0;
    const fm = inp.fwd * (run ? R.runFwd : R.walkFwd), sm = inp.side * (run ? R.runSide : R.walkSide);
    if (p.grounded) {
      const tx = (cy * doomSpeed(fm) + sy * doomSpeed(sm)), ty = (sy * doomSpeed(fm) - cy * doomSpeed(sm));
      const a = 1 - Math.pow(R.friction, dt / DOOM_TIC);
      p.vx += (tx - p.vx) * a; p.vy += (ty - p.vy) * a;
      if (fm === 0 && sm === 0 && Math.abs(p.vx) < 2.2 && Math.abs(p.vy) < 2.2) { p.vx = 0; p.vy = 0; }   // STOPSPEED
      if (R.canJump && (inp.buttons & BTN.JUMP)) { p.vz = JUMP_V; p.grounded = false; events && events.push({ t: 'jump', p: p.id }); }
    }
  } else {
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
  }
  if (!p.grounded) p.vz -= R.gravity * dt;
  // horizontal
  moveCircle(prep, p, p.vx * dt, p.vy * dt, F, C);
  // vertical
  const si = sectorAt(prep, p.x, p.y);
  const fl = F[si], ce = C[si];
  const wasGrounded = p.grounded;
  if (!wasGrounded) p.z += p.vz * dt;
  if (p.z < fl) {
    if (wasGrounded) { if (fl - p.z > STEP_SMOOTH) p.stepOff -= fl - p.z; } // stepped up a stair: snap physics, ease the camera (not for moving lifts)
    else if (p.vz < -250) events && events.push({ t: 'land', p: p.id, v: -p.vz });
    p.z = fl; p.vz = 0; p.grounded = true;
  } else if (p.z > fl + 0.001) {
    if (wasGrounded && p.z - fl <= STEP_MAX) { if (p.z - fl > STEP_SMOOTH) p.stepOff += p.z - fl; p.z = fl; p.grounded = true; } // walk down stairs glued
    else p.grounded = false;
  } else p.grounded = true;
  if (p.z + HEIGHT > ce) { p.z = ce - HEIGHT; if (p.vz > 0) p.vz = 0; }
}

// ---------------------------------------------------------------- world
export function createWorld(map, seed = 1, opts = {}) {
  const prep = prepareMap(map);
  if (opts.pointInSector) prep.pointInSector = opts.pointInSector;
  const world = { map, prep, tick: 0, seed: seed >>> 0, rng: seed >>> 0, players: {}, projectiles: [], nextProj: 1, pickups: [], events: [], auth: true, rules: getRules(opts.rules), wpn: null,
    spawns: [] };
  world.wpn = weaponTable(world.rules);
  initDynamics(world);
  for (const t of map.things) if (t.type === 11) world.spawns.push({ x: t.x, y: t.y, angle: t.angle });
  if (!world.spawns.length) for (const t of map.things) if (t.type >= 1 && t.type <= 4) world.spawns.push({ x: t.x, y: t.y, angle: t.angle });
  if (!world.spawns.length) world.spawns.push({ x: (prep.minX + prep.maxX) / 2, y: (prep.minY + prep.maxY) / 2, angle: 0 });
  for (const t of map.things) {
    const it = ITEMS[t.type];
    if (!it) continue;
    world.pickups.push({ type: t.type, x: t.x, y: t.y, z: floorAt(prep, t.x, t.y, world.sectorFloor), active: true, timer: 0 });
  }
  return world;
}
// lightweight world used by clients for prediction (no combat effects, shares map prep)
export function createPredictWorld(map, opts = {}) {
  const prep = prepareMap(map);
  if (opts.pointInSector) prep.pointInSector = opts.pointInSector;
  const world = { map, prep, tick: 0, rng: 1, players: {}, projectiles: [], pickups: [], events: [], auth: false, spawns: [], nextProj: 1, rules: getRules(opts.rules) };
  world.wpn = weaponTable(world.rules);
  initDynamics(world);
  return world;
}
// live sector heights + mover/switch state (kept on the world: several worlds may share one prepared map)
function initDynamics(world) {
  const prep = world.prep, nl = prep.lines.length;
  world.sectorFloor = prep.baseFloor.slice(); world.sectorCeil = prep.baseCeil.slice();
  world.movers = []; world.lineDone = new Uint8Array(nl); world.switchedLines = new Uint8Array(nl); world.buttons = [];
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
  p.x = s.x; p.y = s.y; p.z = floorAt(world.prep, s.x, s.y, world.sectorFloor); p.vx = p.vy = p.vz = 0; p.stepOff = 0;
  p.yaw = ((s.angle || 0) * Math.PI / 180 + TWO_PI) % TWO_PI; p.pitch = 0;
  p.health = 100; p.armor = 0; p.armorType = 0; p.alive = true; p.grounded = true;
  p.weapon = 0; p.pendW = 0; p.wstate = 0; p.wtimer = 0; p.cooldown = 0; p.owned = 1; p.ammo = START_AMMO.slice();
  p.spawnProt = SPAWN_PROT_TICKS; p.respawn = 0;
  world.events.push({ t: 'spawn', p: p.id, x: p.x, y: p.y, z: p.z });
}

// ---------------------------------------------------------------- ray tracing
// Returns {s, kind:'none'|'wall'|'sky'|'player', target, x,y,z}. 'sky' = the ray left through a sky ceiling (missiles vanish there, as in Doom). (dx,dy,dz) must be a unit vector.
// posFn(id) -> {x,y,z} gives (possibly rewound) player positions.
// Floors and ceilings are tested per sector along the ray (split at every two-sided line it crosses), so a shot can leave
// its own sector: aiming down off a ledge or up out of a pit is not stopped by the *origin* sector's floor/ceiling plane.
const _rayX = [];
export function traceRay(world, ox, oy, oz, dx, dy, dz, range, shooterId, posFn, extraR = 0, skipId = -1) {
  const prep = world.prep, F = world.sectorFloor, C = world.sectorCeil;
  let best = range, kind = 'none', target = -1, nx = 0;
  // walls
  for (let i = 0; i < prep.lines.length; i++) {
    const l = prep.lines[i];
    const den = dx * l.dy - dy * l.dx;
    if (Math.abs(den) < 1e-12) continue;
    const ax = l.ax - ox, ay = l.ay - oy;
    const s = (ax * l.dy - ay * l.dx) / den, u = (ax * dy - ay * dx) / den;
    if (s < -1e-4 || s > best || u < 0 || u > 1) continue;
    const z = oz + dz * s;
    if (l.oneSided) { best = s; kind = 'wall'; continue; }   // (a sky-textured upper wall of a one-sided line is still a wall)
    if (z < Math.max(F[l.fs], F[l.bs]) || z > Math.min(C[l.fs], C[l.bs])) { best = s; kind = z > Math.min(C[l.fs], C[l.bs]) && prep.sky[l.fs] && prep.sky[l.bs] ? 'sky' : 'wall'; }
    else if (s > 0) _rayX[nx++] = s;
  }
  // floor / ceiling of every sector the ray passes through (only needed when it is not horizontal)
  if (dz < -1e-9 || dz > 1e-9) {
    for (let i = 1; i < nx; i++) { const v = _rayX[i]; let j = i - 1; while (j >= 0 && _rayX[j] > v) { _rayX[j + 1] = _rayX[j]; j--; } _rayX[j + 1] = v; }
    let s0 = 0;
    for (let k = 0; k <= nx && s0 < best; k++) {
      const s1 = k < nx ? Math.min(_rayX[k], best) : best;
      if (s1 - s0 < 1e-6) continue;
      const m = (s0 + s1) * 0.5, sec = sectorAt(prep, ox + dx * m, oy + dy * m);
      const sp = (dz < 0 ? F[sec] : C[sec]) - oz, st = sp / dz;
      if (st > 0 && st >= s0 && st < s1) { best = st; kind = dz > 0 && prep.sky[sec] ? 'sky' : 'wall'; break; }
      s0 = s1;
    }
  }
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

// can an explosion at (x,y,z) see any of the player's body (feet / centre / head)? Walls, floors and ceilings block it.
const _noPlayers = () => null;
function splashReaches(world, x, y, z, pl) {
  for (const h of [HEIGHT / 2, HEIGHT - 4, 4]) {
    const tx = pl.x - x, ty = pl.y - y, tz = pl.z + h - z, d = Math.hypot(tx, ty, tz);
    if (d < 1) return true;
    if (traceRay(world, x, y, z, tx / d, ty / d, tz / d, d, -1, _noPlayers).kind === 'none') return true;
  }
  return false;
}
function explode(world, proj, x, y, z, directTarget) {
  const def = world.wpn[proj.w].proj, hk = world.rules.horizontalKnock;
  world.events.push({ t: 'explode', x, y, z, w: proj.w });
  if (def.splash <= 0) return;
  for (const id of sortedIds(world)) {
    const pl = world.players[id];
    if (!pl.alive) continue;
    const cx = pl.x, cy = pl.y, cz = pl.z + HEIGHT / 2;
    const dist = Math.hypot(x - cx, y - cy, z - cz);
    const d = Math.max(0, dist - RADIUS);
    if (d >= def.splashRadius) continue;
    if (!splashReaches(world, x, y, z, pl)) continue;   // like Doom's radius attack: no damage through walls
    const dmg = Math.floor(def.splash * (1 - d / def.splashRadius));
    if (dmg <= 0) continue;
    const taken = damagePlayer(world, pl, dmg, proj.owner, proj.w);
    world.events.push({ t: 'hit', p: proj.owner, target: id, dmg: taken, x: cx, y: cy, z: cz, w: proj.w, splash: 1 });
    // knockback. Vanilla Doom pushes horizontally only (damage/8 map units per tic of momentum); modern adds lift.
    if (hk) {
      const L = Math.hypot(cx - x, cy - y);
      if (L > 1e-3) { const kb = dmg * 0.125 * 35; pl.vx += (cx - x) / L * kb; pl.vy += (cy - y) / L * kb; }
      else if (pl.id === proj.owner) { /* straight down / point blank: no push */ }
    } else {
      const L = dist || 1, kb = Math.min(dmg * 4, 700);
      pl.vx += (cx - x) / L * kb; pl.vy += (cy - y) / L * kb;
      pl.vz += Math.max(0, (cz - z) / L) * kb * 0.6 + (dmg > 20 ? 60 : 0); if (pl.vz > 0) pl.grounded = false;
    }
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
function beginSwitch(world, p, w) { p.pendW = w; p.wstate = WS.LOWER; p.wtimer = world.rules.switchTicks; }

function weaponCommand(world, p, inp, opts) {
  const ev = world.events, sw = world.rules.switchTicks;
  if (p.cooldown > 0) p.cooldown--;
  if (p.wstate === WS.LOWER) {
    if (--p.wtimer <= 0) { p.weapon = p.pendW; p.wstate = WS.RAISE; p.wtimer = sw; ev.push({ t: 'switch', p: p.id, w: p.weapon }); }
  } else if (p.wstate === WS.RAISE) {
    if (--p.wtimer <= 0) { p.wstate = WS.READY; p.wtimer = 0; }
  } else if (inp.weapon > 0 && inp.weapon - 1 < WEAPONS.length && inp.weapon - 1 !== p.weapon && ownsWeapon(p, inp.weapon - 1)) {
    beginSwitch(world, p, inp.weapon - 1);
  }
  const fireDown = (inp.buttons & BTN.FIRE) !== 0, edge = fireDown && !(p.lastButtons & BTN.FIRE);
  const d = world.wpn[p.weapon];
  if (p.wstate === WS.READY && p.cooldown === 0) {
    if (!fireDown) p.refire = 0;
    if (hasAmmo(p, p.weapon)) { if (d.auto || world.rules.autoAll ? fireDown : edge) shoot(world, p, inp, d, opts); }
    else if (fireDown) { const b = bestWeapon(p); if (b !== p.weapon) beginSwitch(world, p, b); }   // out of ammo: fall back (also while fire is merely held)
  }
  p.lastButtons = inp.buttons;
}

// Vanilla-style autoaim: look for a target within +-5.6 degrees of the aim line (Doom tries the aim angle and +-1<<26) that is
// in line of sight, and return the pitch to it. {found, dyaw, pitch}
const _aim = { found: false, dyaw: 0, pitch: 0 };
function autoAim(world, p, ox, oy, oz, yaw, range, posFn) {
  _aim.found = false;
  let bestA = 1e9;
  for (const id of sortedIds(world)) {
    const t = world.players[id];
    if (id === p.id || !t.alive) continue;
    const pos = posFn ? posFn(id) : t; if (!pos) continue;
    const dx = pos.x - ox, dy = pos.y - oy, dist = Math.hypot(dx, dy);
    if (dist < 1 || dist > range) continue;
    let da = Math.atan2(dy, dx) - yaw; da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > 0.0982 || Math.abs(da) >= bestA) continue;
    const tz = pos.z + HEIGHT * 0.6 - oz, pitch = Math.atan2(tz, dist);
    if (Math.abs(pitch) > 0.56) continue;                       // vanilla's +-100/160 slope window
    const l = Math.hypot(dist, tz), r = traceRay(world, ox, oy, oz, dx / l, dy / l, tz / l, l + 1, p.id, posFn);
    if (r.kind !== 'player' || r.target !== id) continue;
    bestA = Math.abs(da); _aim.found = true; _aim.dyaw = da; _aim.pitch = pitch;
  }
  return _aim;
}

function shoot(world, p, inp, d, opts) {
  p.ammo[d.ammoType] -= d.cost;
  p.cooldown = d.cooldown;
  const ox = p.x, oy = p.y, oz = p.z + world.rules.eye;
  world.events.push({ t: 'fire', p: p.id, w: d.id, x: ox, y: oy, z: oz });
  const refire = p.refire | 0; p.refire = 1;
  if (!world.auth) return; // prediction world: only the local, deterministic consequences
  p.spawnProt = 0; // firing ends spawn protection
  const lag = opts && opts.lagComp ? opts.lagComp(p.id, inp) : null;
  const posFn = lag ? (id => lag[id] || world.players[id]) : null;
  let baseYaw = p.yaw, basePitch = p.pitch;
  if (inp.buttons & BTN.AUTOAIM) {
    const a = autoAim(world, p, ox, oy, oz, baseYaw, d.kind === 'hitscan' ? 2048 : 2048, posFn);
    if (a.found) { basePitch = a.pitch; if (d.kind !== 'hitscan') baseYaw += a.dyaw; }
  }
  const ds = d.dspread;
  for (let i = 0; i < d.pellets; i++) {
    let yaw = baseYaw, pitch = basePitch;
    if (ds) {
      if (!(ds.first && !refire)) yaw += (rand(world) - rand(world)) * ds.h;
      if (ds.v) pitch = Math.atan(Math.tan(pitch) + (rand(world) - rand(world)) * ds.v);
    } else if (d.spread) { yaw += (rand(world) * 2 - 1) * d.spread; pitch += (rand(world) * 2 - 1) * d.spread * 0.6; }
    const cp = Math.cos(pitch), dx = Math.cos(yaw) * cp, dy = Math.sin(yaw) * cp, dz = Math.sin(pitch);
    if (d.kind === 'hitscan') {
      const r = traceRay(world, ox, oy, oz, dx, dy, dz, d.range, p.id, posFn);
      if (world.prep.gunLines.length) shootLines(world, ox, oy, dx, dy, r.s);
      if (r.kind === 'player') {
        const dmg = rollDmg(world, d.dmg), tg = world.players[r.target];
        const taken = damagePlayer(world, tg, dmg, p.id, d.id);
        world.events.push({ t: 'hit', p: p.id, target: r.target, dmg: taken, x: r.x, y: r.y, z: r.z, w: d.id });
      } else if (r.kind === 'wall') world.events.push({ t: 'impact', x: r.x - dx * 0.5, y: r.y - dy * 0.5, z: r.z - dz * 0.5, w: d.id });
    } else {
      const pd = d.proj;
      // The missile starts 12 units ahead of the eye line, 8 below it (Doom: z + 32). If that segment crosses a wall (standing
      // against it) the rocket explodes right there instead of being created inside the wall.
      const sz = oz - 8;
      const r = traceRay(world, ox, oy, oz, dx, dy, dz, 12, p.id, null, 0, -2);
      const pr = { id: world.nextProj++, owner: p.id, w: d.id, x: ox + dx * 12, y: oy + dy * 12, z: sz + dz * 12,
        vx: dx * pd.speed, vy: dy * pd.speed, vz: dz * pd.speed, ttl: pd.ttl, dmg: rollDmg(world, pd.dmg) };
      if (r.kind === 'wall') { pr.x = r.x - dx * 2; pr.y = r.y - dy * 2; pr.z = r.z - dz * 2; explode(world, pr, pr.x, pr.y, pr.z, -1); }
      else if (r.kind === 'sky') { /* fired into a sky ceiling: it just flies away */ }
      else world.projectiles.push(pr);
    }
  }
}

function updateProjectiles(world, dt) {
  const keep = [];
  for (const pr of world.projectiles) {
    const def = world.wpn[pr.w].proj;
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
    if (r.kind === 'sky') { world.events.push({ t: 'vanish', w: pr.w, x: r.x, y: r.y, z: r.z }); continue; }   // Doom removes missiles that hit the sky silently
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
      if (isNew && p.wstate === WS.READY) beginSwitch(world, p, it.weapon);
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

// ---------------------------------------------------------------- line specials, movers (doors / lifts / floors), switches, teleports
// Doom speeds are per 35 Hz tic; converted to per 60 Hz tick. Heights live in world.sectorFloor / world.sectorCeil (Float32Array).
const T35 = 35 / 60;
export const DOOR_SPEED = 2 * T35, DOOR_FAST = 8 * T35, LIFT_SPEED = 4 * T35, LIFT_FAST = 8 * T35, PERP_SPEED = 1 * T35, FLOOR_SPEED = 1 * T35, FLOOR_FAST = 4 * T35;
export const DOOR_WAIT = Math.round(150 * 60 / 35), PLAT_WAIT = 180, CLOSE30_WAIT = 1800, BUTTON_TICKS = 60, USE_RANGE = 64;
export const MK = { DOOR: 1, PLAT: 2, FLOOR: 3 };
export const EVM = { OPEN: 1, CLOSE: 2, LIFT_DOWN: 3, LIFT_UP: 4, STOP: 5, FLOOR: 6 };

// special -> {trig: 'W'alk|'S'witch|'G'un|'D'oor(use), once, fam, mode, fast}
const SPECIALS = {};
{
  const add = (trig, fam, mode, fast, ...ns) => { for (const n of ns) SPECIALS[n] = { trig: trig[0], once: trig[1] === '1', fam, mode, fast }; };
  add('DR', 'mdoor', 'owc', 0, 1, 26, 27, 28); add('DR', 'mdoor', 'owc', 1, 117);               // keys are not modelled in deathmatch
  add('D1', 'mdoor', 'open', 0, 31, 32, 33, 34); add('D1', 'mdoor', 'open', 1, 118);
  add('W1', 'door', 'open', 0, 2); add('W1', 'door', 'close', 0, 3); add('W1', 'door', 'owc', 0, 4); add('W1', 'door', 'c30', 0, 16);
  add('S1', 'door', 'owc', 0, 29); add('SR', 'door', 'close', 0, 42); add('GR', 'door', 'open', 0, 46); add('S1', 'door', 'close', 0, 50);
  add('SR', 'door', 'open', 0, 61); add('SR', 'door', 'owc', 0, 63); add('WR', 'door', 'close', 0, 75); add('WR', 'door', 'c30', 0, 76);
  add('WR', 'door', 'open', 0, 86); add('WR', 'door', 'owc', 0, 90); add('S1', 'door', 'open', 0, 103);
  add('WR', 'door', 'owc', 1, 105); add('WR', 'door', 'open', 1, 106); add('WR', 'door', 'close', 1, 107);
  add('W1', 'door', 'owc', 1, 108); add('W1', 'door', 'open', 1, 109); add('W1', 'door', 'close', 1, 110);
  add('S1', 'door', 'owc', 1, 111); add('S1', 'door', 'open', 1, 112); add('S1', 'door', 'close', 1, 113);
  add('SR', 'door', 'owc', 1, 114); add('SR', 'door', 'open', 1, 115); add('SR', 'door', 'close', 1, 116);
  add('SR', 'door', 'open', 1, 99, 134, 136); add('S1', 'door', 'open', 1, 133, 135, 137);
  add('W1', 'lift', '', 0, 10); add('S1', 'lift', '', 0, 21); add('SR', 'lift', '', 0, 62); add('WR', 'lift', '', 0, 88);
  add('WR', 'lift', '', 1, 120); add('W1', 'lift', '', 1, 121); add('S1', 'lift', '', 1, 122); add('SR', 'lift', '', 1, 123);
  add('W1', 'perp', '', 0, 53); add('WR', 'perp', '', 0, 87); add('W1', 'stop', '', 0, 54); add('WR', 'stop', '', 0, 89);
  // floors (texture changes are not modelled)
  add('W1', 'floor', 'raiseCeil', 0, 5); add('W1', 'floor', 'lowHigh', 0, 19); add('W1', 'floor', 'lowHigh8', 1, 36); add('W1', 'floor', 'lowLow', 0, 37, 38);
  add('W1', 'floor', 'raise24', 0, 58, 59); add('W1', 'floor', 'raiseNext', 0, 119);
  add('WR', 'floor', 'lowLow', 0, 82, 84); add('WR', 'floor', 'lowHigh', 0, 83); add('WR', 'floor', 'raiseCeil', 0, 91); add('WR', 'floor', 'raise24', 0, 92, 93);
  add('WR', 'floor', 'lowHigh8', 1, 98); add('WR', 'floor', 'raiseNext', 0, 128); add('WR', 'floor', 'raiseNext', 1, 129);
  add('S1', 'floor', 'raise32', 0, 14); add('S1', 'floor', 'raise24', 0, 15); add('S1', 'floor', 'raiseNext', 0, 18, 20); add('S1', 'floor', 'lowLow', 0, 23);
  add('S1', 'floor', 'raiseCeil', 0, 101); add('S1', 'floor', 'lowHigh', 0, 102); add('S1', 'floor', 'raiseNext', 1, 131); add('S1', 'floor', 'raise512', 0, 140);
  add('SR', 'floor', 'lowHigh', 0, 45); add('SR', 'floor', 'lowLow', 0, 60); add('SR', 'floor', 'raiseCeil', 0, 64); add('SR', 'floor', 'raiseNext', 0, 69);
  add('SR', 'floor', 'lowHigh8', 1, 70); add('SR', 'floor', 'raiseNext', 1, 132);
  // teleporters always repeat here so that prediction (which has no memory of consumed lines) never diverges
  add('WR', 'tele', '', 0, 39, 97, 125, 126);
}
export const lineSpecialInfo = n => SPECIALS[n] || null;

const evAt = (world, s, a) => { if (world.auth) world.events.push({ t: 'mover', s, a, x: world.prep.secCx[s], y: world.prep.secCy[s], z: world.sectorFloor[s] }); };
const findMover = (world, s) => { for (const m of world.movers) if (m.s === s) return m; return null; };

// neighbour height queries over live heights (Doom's P_FindXxxSurrounding)
function neighbourExtreme(world, s, arr, lowest, start) {
  let h = start;
  for (const li of world.prep.secLines[s]) {
    const l = world.prep.lines[li];
    if (l.fs < 0 || l.bs < 0) continue;
    const o = l.fs === s ? l.bs : l.fs; if (o === s) continue;
    const v = arr[o]; if (lowest ? v < h : v > h) h = v;
  }
  return h;
}
const lowestNeighCeil = (w, s) => neighbourExtreme(w, s, w.sectorCeil, true, 32000);
const lowestNeighFloor = (w, s) => neighbourExtreme(w, s, w.sectorFloor, true, w.sectorFloor[s]);
const highestNeighFloor = (w, s) => neighbourExtreme(w, s, w.sectorFloor, false, -500);
function nextHigherFloor(w, s) {
  const cur = w.sectorFloor[s]; let h = 32000;
  for (const li of w.prep.secLines[s]) {
    const l = w.prep.lines[li]; if (l.fs < 0 || l.bs < 0) continue;
    const o = l.fs === s ? l.bs : l.fs, v = w.sectorFloor[o];
    if (v > cur && v < h) h = v;
  }
  return h === 32000 ? cur : h;
}

// would a floor at `nf` / ceiling at `nc` leave a player centred in sector s without room?
function playerSqueezed(world, s, nf, nc) {
  for (const id of sortedIds(world)) {
    const p = world.players[id];
    if (!p.alive || sectorAt(world.prep, p.x, p.y) !== s) continue;
    if (Math.max(p.z, nf) + HEIGHT > nc) return true;
  }
  return false;
}
function carryPlayers(world, s, nf) {
  for (const id of sortedIds(world)) {
    const p = world.players[id];
    if (!p.alive || p.z >= nf || sectorAt(world.prep, p.x, p.y) !== s) continue;
    p.z = nf; if (p.vz < 0) p.vz = 0; p.grounded = true;
  }
}

function startDoor(world, s, mode, fast) {
  const F = world.sectorFloor, C = world.sectorCeil;
  const m = { k: MK.DOOR, s, st: 1, o: 0, f: 0, g: 0, spd: fast ? DOOR_FAST : DOOR_SPEED, a: 0, b: 0, t: 0, w: DOOR_WAIT };
  const top = Math.max(F[s], lowestNeighCeil(world, s) - 4);
  if (mode === 'open') { m.f = 1; m.a = top; evAt(world, s, EVM.OPEN); }
  else if (mode === 'owc') { m.a = top; evAt(world, s, EVM.OPEN); }
  else if (mode === 'close') { m.st = -1; m.f = 2; m.a = C[s]; evAt(world, s, EVM.CLOSE); }
  else { m.st = -1; m.f = 1 | 8; m.a = C[s]; m.w = CLOSE30_WAIT; evAt(world, s, EVM.CLOSE); }  // close, wait 30 s, reopen
  world.movers.push(m);
}
function stepDoor(world, m) {
  const F = world.sectorFloor, C = world.sectorCeil, s = m.s;
  if (m.st === 0) { if (--m.t <= 0) { m.st = -1; evAt(world, s, EVM.CLOSE); } }
  else if (m.st === 2) { if (--m.t <= 0) { m.st = 1; evAt(world, s, EVM.OPEN); } }
  else if (m.st === 1) {
    const c = C[s] + m.spd;
    if (c >= m.a) {
      if (C[s] < m.a) C[s] = m.a;
      evAt(world, s, EVM.STOP);
      if (m.f & 1) return false;
      m.st = 0; m.t = m.w;
    } else C[s] = c;
  } else {
    const floor = F[s], c = Math.max(floor, C[s] - m.spd);
    if (playerSqueezed(world, s, floor, c)) { m.st = 1; evAt(world, s, EVM.OPEN); return true; } // never crushes: blocked doors reopen
    C[s] = c;
    if (c <= floor) {
      C[s] = floor; evAt(world, s, EVM.STOP);
      if (m.f & 8) { m.st = 2; m.t = m.w; } else return false;
    }
  }
  return true;
}
function startLift(world, s, fast, perpetual) {
  const F = world.sectorFloor;
  const m = { k: MK.PLAT, s, st: -1, o: 0, f: 0, g: world.prep.map.sectors[s].tag, spd: fast ? LIFT_FAST : LIFT_SPEED, a: lowestNeighFloor(world, s), b: F[s], t: 0, w: PLAT_WAIT };
  if (perpetual) { m.f = 1; m.spd = PERP_SPEED; m.b = Math.max(highestNeighFloor(world, s), F[s]); m.st = rand(world) < 0.5 ? 1 : -1; }
  world.movers.push(m);
  evAt(world, s, m.st < 0 ? EVM.LIFT_DOWN : EVM.LIFT_UP);
}
function stepPlat(world, m) {
  const F = world.sectorFloor, C = world.sectorCeil, s = m.s;
  if (m.st === 3) return true;
  if (m.st === -1) {
    const f = F[s] - m.spd;
    if (f <= m.a) { F[s] = m.a; m.st = 0; m.t = m.w; evAt(world, s, EVM.STOP); } else F[s] = f;
  } else if (m.st === 1) {
    let f = F[s] + m.spd, arrived = false;
    if (f >= m.b) { f = m.b; arrived = true; }
    if (playerSqueezed(world, s, f, C[s])) { m.st = -1; m.t = 0; evAt(world, s, EVM.LIFT_DOWN); return true; } // reverses instead of crushing
    F[s] = f; carryPlayers(world, s, f);
    if (arrived) { evAt(world, s, EVM.STOP); if (m.f & 1) { m.st = 0; m.t = m.w; } else return false; }
  } else if (--m.t <= 0) {
    if (F[s] <= m.a) { m.st = 1; evAt(world, s, EVM.LIFT_UP); } else { m.st = -1; evAt(world, s, EVM.LIFT_DOWN); }
  }
  return true;
}
function stepFloor(world, m) {
  const F = world.sectorFloor, C = world.sectorCeil, s = m.s;
  if (m.st === 1) {
    let f = F[s] + m.spd, arrived = false;
    if (f >= m.a) { f = m.a; arrived = true; }
    if (playerSqueezed(world, s, f, C[s])) return true; // waits until clear
    F[s] = f; carryPlayers(world, s, f);
    if (arrived) { evAt(world, s, EVM.STOP); return false; }
  } else {
    const f = F[s] - m.spd;
    if (f <= m.a) { F[s] = m.a; evAt(world, s, EVM.STOP); return false; }
    F[s] = f;
  }
  return true;
}
function updateMovers(world) {
  const ms = world.movers;
  for (let i = 0; i < ms.length;) {
    const m = ms[i];
    const keep = m.k === MK.DOOR ? stepDoor(world, m) : m.k === MK.PLAT ? stepPlat(world, m) : stepFloor(world, m);
    if (keep) i++; else ms.splice(i, 1);
  }
  const bs = world.buttons;
  for (let i = 0; i < bs.length;) { if (--bs[i].t <= 0) { world.switchedLines[bs[i].li] = 0; bs.splice(i, 1); } else i++; }
}

function manualDoor(world, l, sp, side) {
  if (side !== 0 || l.bs < 0) return false;
  const s = l.bs, m = findMover(world, s);
  if (m) {
    if (m.k !== MK.DOOR || sp.mode !== 'owc') return false;
    if (m.st === -1) { m.st = 1; evAt(world, s, EVM.OPEN); } else { m.st = -1; evAt(world, s, EVM.CLOSE); }
    return true;
  }
  startDoor(world, s, sp.mode, sp.fast);
  return true;
}
function eachTagged(world, tag, fn) {
  const list = tag ? world.prep.tagSectors.get(tag) : null; let any = false;
  if (list) for (const s of list) if (!findMover(world, s)) { fn(s); any = true; }
  return any;
}
const tagDoor = (world, tag, mode, fast) => eachTagged(world, tag, s => startDoor(world, s, mode, fast));
const tagLift = (world, tag, fast) => eachTagged(world, tag, s => startLift(world, s, fast, false));
function tagPerp(world, tag) {
  for (const m of world.movers) if (m.k === MK.PLAT && m.st === 3 && m.g === tag) m.st = m.o;
  return eachTagged(world, tag, s => startLift(world, s, false, true));
}
function stopPlats(world, tag) {
  let any = false;
  for (const m of world.movers) if (m.k === MK.PLAT && m.st !== 3 && m.g === tag) { m.o = m.st; m.st = 3; any = true; }
  return any;
}
function tagFloor(world, tag, mode, fast) {
  return eachTagged(world, tag, s => {
    const F = world.sectorFloor, C = world.sectorCeil;
    let dest;
    switch (mode) {
      case 'lowLow': dest = lowestNeighFloor(world, s); break;
      case 'lowHigh': dest = highestNeighFloor(world, s); break;
      case 'lowHigh8': dest = highestNeighFloor(world, s); if (dest !== F[s]) dest += 8; break;
      case 'raiseCeil': dest = Math.min(lowestNeighCeil(world, s), C[s]); break;
      case 'raiseNext': dest = nextHigherFloor(world, s); break;
      case 'raise24': dest = F[s] + 24; break;
      case 'raise32': dest = F[s] + 32; break;
      default: dest = F[s] + 512;
    }
    if (dest === F[s]) return;
    world.movers.push({ k: MK.FLOOR, s, st: dest > F[s] ? 1 : -1, o: 0, f: 0, g: world.prep.map.sectors[s].tag, spd: fast ? FLOOR_FAST : FLOOR_SPEED, a: dest, b: 0, t: 0, w: 0 });
    evAt(world, s, EVM.FLOOR);
  });
}

function pressSwitch(world, li, once) {
  if (!world.prep.lines[li].sw || world.switchedLines[li]) return;
  world.switchedLines[li] = 1;
  if (!once) world.buttons.push({ li, t: BUTTON_TICKS });
}
// kind: 'W' walked over, 'S' switch used, 'D' manual door used, 'G' shot. Returns true when something started.
function fireSpecial(world, li, kind, side) {
  const l = world.prep.lines[li], sp = SPECIALS[l.special];
  if (!sp || sp.trig !== kind || world.lineDone[li]) return false;
  let ok = false;
  switch (sp.fam) {
    case 'mdoor': ok = manualDoor(world, l, sp, side); break;
    case 'door': ok = tagDoor(world, l.tag, sp.mode, sp.fast); break;
    case 'lift': ok = tagLift(world, l.tag, sp.fast); break;
    case 'perp': ok = tagPerp(world, l.tag); break;
    case 'stop': ok = stopPlats(world, l.tag); break;
    case 'floor': ok = tagFloor(world, l.tag, sp.mode, sp.fast); break;
  }
  if (kind === 'W') { if (sp.once) world.lineDone[li] = 1; }
  else if (ok) { if (kind !== 'D') pressSwitch(world, li, sp.once); if (sp.once) world.lineDone[li] = 1; }
  return ok;
}
// Fire a line's special as its own trigger type would (tests, demos, scripted map events). Teleports are not handled here.
export function triggerLine(world, li) {
  const sp = SPECIALS[world.prep.lines[li].special];
  return !!sp && fireSpecial(world, li, sp.trig, 0);
}

const _useBuf = [], _crossBuf = [];
// USE: trace USE_RANGE units along the view yaw from the player; the first line with a special is used (from its front side only).
function usePlayer(world, p) {
  const prep = world.prep, F = world.sectorFloor, C = world.sectorCeil;
  const ox = p.x, oy = p.y, dx = Math.cos(p.yaw), dy = Math.sin(p.yaw), ex = ox + dx * USE_RANGE, ey = oy + dy * USE_RANGE;
  nearbyLines(prep, Math.min(ox, ex) - 1, Math.min(oy, ey) - 1, Math.max(ox, ex) + 1, Math.max(oy, ey) + 1, _useBuf);
  // walk the hit lines front to back; a plain line that has no opening ends the trace
  const hits = [];
  for (let k = 0; k < _useBuf.length; k++) {
    const i = _useBuf[k], l = prep.lines[i], den = dx * l.dy - dy * l.dx;
    if (Math.abs(den) < 1e-12) continue;
    const ax = l.ax - ox, ay = l.ay - oy, t = (ax * l.dy - ay * l.dx) / den, u = (ax * dy - ay * dx) / den;
    if (t < 0 || t > USE_RANGE || u < 0 || u > 1) continue;
    hits.push(i, t);
  }
  for (let n = 0; n < hits.length; n += 2) { // selection by smallest t (hits is tiny)
    let bi = -1, bv = Infinity;
    for (let m = 0; m < hits.length; m += 2) if (hits[m + 1] < bv) { bv = hits[m + 1]; bi = m; }
    if (bi < 0) break;
    const i = hits[bi]; hits[bi + 1] = Infinity;
    const l = prep.lines[i];
    if (l.special) {
      const side = l.dx * (oy - l.ay) - l.dy * (ox - l.ax) < 0 ? 0 : 1;
      const sp = SPECIALS[l.special];
      if (sp && (sp.trig === 'D' || sp.trig === 'S')) fireSpecial(world, i, sp.trig, side);
      return;
    }
    if (l.oneSided || Math.min(C[l.fs], C[l.bs]) - Math.max(F[l.fs], F[l.bs]) <= 0) return;
  }
}

function teleDest(prep, tag) {
  if (!prep.tele) {
    prep.tele = new Map();
    const bySec = new Map();
    for (const t of prep.map.things) if (t.type === 14) { const s = sectorAt(prep, t.x, t.y); if (!bySec.has(s)) bySec.set(s, t); }
    prep.map.sectors.forEach((sc, i) => { if (sc.tag && !prep.tele.has(sc.tag) && bySec.has(i)) { const t = bySec.get(i); prep.tele.set(sc.tag, { x: t.x, y: t.y, angle: t.angle, sector: i }); } });
  }
  return prep.tele.get(tag) || null;
}
function teleport(world, p, l, tag) {
  const d = teleDest(world.prep, tag);
  if (!d) return false;
  const ev = world.events;
  ev.push({ t: 'teleport', p: p.id, out: 1, x: p.x, y: p.y, z: p.z, yaw: 0 });
  p.x = d.x; p.y = d.y; p.z = world.sectorFloor[d.sector]; p.vx = p.vy = p.vz = 0; p.stepOff = 0; p.grounded = true;
  p.yaw = ((d.angle || 0) * Math.PI / 180 + TWO_PI) % TWO_PI;
  ev.push({ t: 'teleport', p: p.id, out: 0, x: d.x, y: d.y, z: p.z, yaw: Math.round(d.angle || 0) });
  return true;
}
// after a move from (x0,y0) to the player's position: fire walk-over specials / teleporters whose line was crossed
function checkCross(world, p, x0, y0) {
  const prep = world.prep, x1 = p.x, y1 = p.y;
  if (x0 === x1 && y0 === y1) return;
  nearbyLines(prep, Math.min(x0, x1) - 1, Math.min(y0, y1) - 1, Math.max(x0, x1) + 1, Math.max(y0, y1) + 1, _crossBuf);
  for (let k = 0; k < _crossBuf.length; k++) {
    const i = _crossBuf[k], l = prep.lines[i];
    if (!l.special) continue;
    const sp = SPECIALS[l.special];
    if (!sp || sp.trig !== 'W') continue;
    const o0 = l.dx * (y0 - l.ay) - l.dy * (x0 - l.ax), o1 = l.dx * (y1 - l.ay) - l.dy * (x1 - l.ax);
    const side0 = o0 < 0 ? 0 : 1, side1 = o1 < 0 ? 0 : 1;
    if (side0 === side1) continue;
    const a = (x1 - x0) * (l.ay - y0) - (y1 - y0) * (l.ax - x0), b = (x1 - x0) * (l.by - y0) - (y1 - y0) * (l.bx - x0);
    if (a * b >= 0) continue;
    if (sp.fam === 'tele') { if (side0 === 0 && teleport(world, p, l, l.tag)) return; }
    else if (world.auth) fireSpecial(world, i, 'W', side0);
  }
}
// hitscan shots trigger gun lines they cross before the first blocking surface
function shootLines(world, ox, oy, dx, dy, range) {
  const prep = world.prep;
  for (const i of prep.gunLines) {
    const l = prep.lines[i], den = dx * l.dy - dy * l.dx;
    if (Math.abs(den) < 1e-12) continue;
    const ax = l.ax - ox, ay = l.ay - oy, s = (ax * l.dy - ay * l.dx) / den, u = (ax * dy - ay * dx) / den;
    if (s >= 0 && s <= range && u >= 0 && u <= 1) fireSpecial(world, i, 'G', 0);
  }
}

// per-sector [floor, ceil, floorVel, ceilVel, floorTarget, ceilTarget] state used by network snapshots (velocities are per tick)
export function initialSectorState(prep) {
  const out = new Float32Array(prep.nSec * 6);
  for (let i = 0; i < prep.nSec; i++) { const o = i * 6; out[o] = prep.baseFloor[i]; out[o + 1] = prep.baseCeil[i]; out[o + 4] = prep.baseFloor[i]; out[o + 5] = prep.baseCeil[i]; }
  return out;
}
export function sectorState(world, out = new Float32Array(world.prep.nSec * 6)) {
  const F = world.sectorFloor, C = world.sectorCeil;
  for (let i = 0; i < F.length; i++) { const o = i * 6; out[o] = F[i]; out[o + 1] = C[i]; out[o + 2] = 0; out[o + 3] = 0; out[o + 4] = F[i]; out[o + 5] = C[i]; }
  for (const m of world.movers) {
    const o = m.s * 6;
    if (m.k === MK.DOOR) { if (m.st === 1) { out[o + 3] = m.spd; out[o + 5] = m.a; } else if (m.st === -1) { out[o + 3] = -m.spd; out[o + 5] = F[m.s]; } }
    else if (m.k === MK.PLAT) { if (m.st === 1) { out[o + 2] = m.spd; out[o + 4] = m.b; } else if (m.st === -1) { out[o + 2] = -m.spd; out[o + 4] = m.a; } }
    else { out[o + 2] = (m.st > 0 ? 1 : -1) * m.spd; out[o + 4] = m.a; }
  }
  return out;
}

// ---------------------------------------------------------------- step
// inputs[id] may be one input, an array of inputs (executed in order, one dt each), or absent (player idle this tick).
export function runCommand(world, p, raw, dt, opts) {
  const inp = raw.fwd === undefined ? makeInput(raw) : raw;
  if (p.alive) {
    const x0 = p.x, y0 = p.y;
    moveCommand(world.prep, p, inp, dt, world.events, world);
    if (world.prep.hasSpecials) checkCross(world, p, x0, y0);
    if (world.auth && (inp.buttons & BTN.USE) && !(p.lastButtons & BTN.USE)) usePlayer(world, p);
    weaponCommand(world, p, inp, opts);
  } else p.lastButtons = inp.buttons;
  if (inp.seq) p.lastSeq = inp.seq;
}
const _deadIn = { fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
function deadPhysics(world, p, dt) {
  _deadIn.yaw = p.yaw; _deadIn.pitch = p.pitch;
  moveCommand(world.prep, p, _deadIn, dt, null, world);
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
    if (!p.alive) {
      deadPhysics(world, p, dt);   // corpses fall, slide to a stop and ride lifts; they do not hang in mid-air
      if (p.respawn > 0 && --p.respawn === 0) spawnPlayer(world, p);
    }
  }
  if (world.auth) updateMovers(world);
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
  // dynamic sectors: only heights that differ from the map, then movers, consumed lines, pressed switches
  const F = world.sectorFloor, C = world.sectorCeil, prep = world.prep, ch = [];
  for (let i = 0; i < F.length; i++) if (F[i] !== prep.baseFloor[i] || C[i] !== prep.baseCeil[i]) ch.push(i);
  w.u16(ch.length); for (const i of ch) { w.u16(i); w.f32(F[i]); w.f32(C[i]); }
  w.u16(world.movers.length);
  for (const m of world.movers) { w.u8(m.k); w.u16(m.s); w.i8(m.st); w.i8(m.o); w.u8(m.f); w.u16(m.g); w.f32(m.spd); w.f32(m.a); w.f32(m.b); w.u16(m.t); w.u16(m.w); }
  for (const arr of [world.lineDone, world.switchedLines]) { const l = []; for (let i = 0; i < arr.length; i++) if (arr[i]) l.push(i); w.u16(l.length); for (const i of l) w.u16(i); }
  w.u16(world.buttons.length); for (const b of world.buttons) { w.u16(b.li); w.u16(b.t); }
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
  const nc = r.u16(); for (let i = 0; i < nc; i++) { const si = r.u16(); world.sectorFloor[si] = r.f32(); world.sectorCeil[si] = r.f32(); }
  const nm = r.u16();
  for (let i = 0; i < nm; i++) world.movers.push({ k: r.u8(), s: r.u16(), st: r.i8(), o: r.i8(), f: r.u8(), g: r.u16(), spd: r.f32(), a: r.f32(), b: r.f32(), t: r.u16(), w: r.u16() });
  for (const arr of [world.lineDone, world.switchedLines]) { const n = r.u16(); for (let i = 0; i < n; i++) arr[r.u16()] = 1; }
  const nb = r.u16(); for (let i = 0; i < nb; i++) world.buttons.push({ li: r.u16(), t: r.u16() });
  return world;
}
export function hashWorld(world) {
  const b = serialize(world);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export { WEAPONS, newPlayer, clonePlayer };
