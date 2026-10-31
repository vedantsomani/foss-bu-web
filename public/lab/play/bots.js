// bots.js - practice bots. They run inside the host sim and drive it through the host's own peer API
// (host.addPeer(id, true) + peer.queue), i.e. exactly the same command path a human uses.
// Navigation: a coarse grid flood-filled from the item/spawn positions, edges validated with the sim's own
// moveCircle, and breadth-first distance fields (goal -> every node) that bots descend.
import * as S from '../game/sim.js';
import { WEAPONS, ITEMS, AMMO_MAX } from '../game/weapons.js';

const STEP = 48, DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const INF = 65535, TAU = Math.PI * 2;
export const BOT_NAMES = ['Grunt', 'Reaper', 'Vex', 'Moth', 'Ripper', 'Havoc'];
const NAMES = BOT_NAMES;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Nav {
  constructor(world) {
    const prep = this.prep = world.prep, sec = prep.map.sectors;
    this.minX = prep.minX - STEP; this.minY = prep.minY - STEP;
    this.gw = Math.ceil((prep.maxX - prep.minX) / STEP) + 3; this.gh = Math.ceil((prep.maxY - prep.minY) / STEP) + 3;
    const N = this.N = this.gw * this.gh;
    this.valid = new Uint8Array(N); this.seen = new Uint8Array(N); this.edges = new Uint8Array(N); this.floor = new Float32Array(N);
    this.queue = new Int32Array(N); this.count = 0;
    const probe = { x: 0, y: 0, z: 0, vx: 0, vy: 0 };
    const check = n => {
      if (this.seen[n]) return this.valid[n] === 1;
      this.seen[n] = 1;
      const x = this.minX + (n % this.gw) * STEP, y = this.minY + Math.floor(n / this.gw) * STEP;
      const s = sec[S.sectorAt(prep, x, y)];
      if (!s || s.ceil - s.floor < S.HEIGHT) return false;
      probe.x = x; probe.y = y; probe.z = s.floor; probe.vx = probe.vy = 0;
      S.moveCircle(prep, probe, 0, 0);
      if (Math.hypot(probe.x - x, probe.y - y) > 0.6) return false;
      this.valid[n] = 1; this.floor[n] = s.floor; return true;
    };
    // seeds: every item and spawn, snapped to the nearest clear grid node
    const seeds = [];
    const seedAt = (x, y) => {
      const gx = Math.round((x - this.minX) / STEP), gy = Math.round((y - this.minY) / STEP);
      let best = -1, bd = 1e9;
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const n = (gy + oy) * this.gw + gx + ox; if (n < 0 || n >= N || gx + ox < 0 || gx + ox >= this.gw) continue;
        const d = Math.hypot(this.minX + (gx + ox) * STEP - x, this.minY + (gy + oy) * STEP - y);
        if (d < bd && check(n)) { bd = d; best = n; }
      }
      if (best >= 0) seeds.push(best);
    };
    for (const s of world.spawns) seedAt(s.x, s.y);
    for (const pk of world.pickups) seedAt(pk.x, pk.y);
    // flood fill with edge validation (directed: dropping down is allowed, climbing > STEP_MAX is not)
    let qh = 0, qt = 0; const inq = new Uint8Array(N);
    for (const s of seeds) if (!inq[s]) { inq[s] = 1; this.queue[qt++] = s; }
    while (qh < qt) {
      const a = this.queue[qh++], ax = this.minX + (a % this.gw) * STEP, ay = this.minY + Math.floor(a / this.gw) * STEP;
      let mask = 0;
      for (let d = 0; d < 8; d++) {
        const gx = (a % this.gw) + DIRS[d][0], gy = Math.floor(a / this.gw) + DIRS[d][1];
        if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) continue;
        const b = gy * this.gw + gx;
        if (!check(b)) continue;
        const dz = this.floor[b] - this.floor[a];
        if (dz > S.STEP_MAX || dz < -96) continue;
        probe.x = ax; probe.y = ay; probe.z = this.floor[a]; probe.vx = probe.vy = 0;
        S.moveCircle(prep, probe, DIRS[d][0] * STEP, DIRS[d][1] * STEP);
        if (Math.hypot(probe.x - (ax + DIRS[d][0] * STEP), probe.y - (ay + DIRS[d][1] * STEP)) > 1) continue;
        mask |= 1 << d;
        if (!inq[b]) { inq[b] = 1; this.queue[qt++] = b; }
      }
      this.edges[a] = mask;
    }
    this.count = qt;
    this.nodes = Array.from(this.queue.subarray(0, qt));
    this.q2 = new Int32Array(N);
    // hub[n] = 1 when n can walk to the main connected region (the largest strongly connected set of nodes). Anything else is a
    // trap (e.g. a spawn on a ledge higher than a bot may drop from): bots standing there leave by walking straight to the nearest hub node.
    this.hub = new Uint8Array(N);
    { const gw = this.gw, E = this.edges, ns = this.nodes, comp = new Int32Array(N).fill(-1), seenF = new Uint8Array(N), order = [], stack = [], it = new Uint8Array(N);
      for (const r of ns) {   // pass 1: iterative DFS over forward edges, record finishing order
        if (seenF[r]) continue; seenF[r] = 1; stack.push(r);
        while (stack.length) {
          const a = stack[stack.length - 1]; let adv = false;
          while (it[a] < 8) {
            const d = it[a]++; if (!(E[a] & (1 << d))) continue;
            const b = a + DIRS[d][1] * gw + DIRS[d][0]; if (!seenF[b]) { seenF[b] = 1; stack.push(b); adv = true; break; }
          }
          if (!adv) { stack.pop(); order.push(a); }
        }
      }
      let nc = 0, bestC = -1, bestSize = 0;
      for (let k = order.length - 1; k >= 0; k--) {   // pass 2: flood over reversed edges in reverse finishing order = one SCC each
        const r = order[k]; if (comp[r] >= 0) continue;
        comp[r] = nc; stack.push(r); let size = 0;
        while (stack.length) {
          const b = stack.pop(); size++; const bx = b % gw, by = Math.floor(b / gw);
          for (let d = 0; d < 8; d++) {
            const ax = bx - DIRS[d][0], ay = by - DIRS[d][1]; if (ax < 0 || ay < 0 || ax >= gw || ay >= this.gh) continue;
            const a = ay * gw + ax; if (comp[a] < 0 && (E[a] & (1 << d))) { comp[a] = nc; stack.push(a); }
          }
        }
        if (size > bestSize) { bestSize = size; bestC = nc; }
        nc++;
      }
      const q = this.q2; let h = 0, t = 0;   // everything that can reach the main region
      for (const n of ns) if (comp[n] === bestC) { this.hub[n] = 1; q[t++] = n; }
      while (h < t) {
        const b = q[h++], bx = b % gw, by = Math.floor(b / gw);
        for (let d = 0; d < 8; d++) {
          const ax = bx - DIRS[d][0], ay = by - DIRS[d][1]; if (ax < 0 || ay < 0 || ax >= gw || ay >= this.gh) continue;
          const a = ay * gw + ax; if (!this.hub[a] && (E[a] & (1 << d))) { this.hub[a] = 1; q[t++] = a; }
        }
      } }
  }
  // nearest hub node (not above the bot's step height); -1 when none
  nearestHub(x, y, z) {
    let best = -1, bd = 1e12;
    for (const n of this.nodes) {
      if (!this.hub[n] || this.floor[n] > z + S.STEP_MAX) continue;
      const d = (this.cx(n) - x) ** 2 + (this.cy(n) - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  nodeAt(x, y) {
    const gx = Math.round((x - this.minX) / STEP), gy = Math.round((y - this.minY) / STEP);
    let best = -1, bd = 1e12;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox, cy = gy + oy; if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) continue;
      const n = cy * this.gw + cx; if (!this.valid[n] || !this.edges[n] && this.count > 1) continue;
      const d = (this.minX + cx * STEP - x) ** 2 + (this.minY + cy * STEP - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  // node a bot can actually walk to the item from (a node merely *near* an item may sit behind a wall or under a ledge), or -1
  itemNode(pk) {
    const gx = Math.round((pk.x - this.minX) / STEP), gy = Math.round((pk.y - this.minY) / STEP), cand = [];
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox, cy = gy + oy; if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gh) continue;
      const n = cy * this.gw + cx; if (!this.valid[n] || !this.edges[n] && this.count > 1) continue;
      cand.push([(this.minX + cx * STEP - pk.x) ** 2 + (this.minY + cy * STEP - pk.y) ** 2, n]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const probe = { x: 0, y: 0, z: 0, vx: 0, vy: 0 };
    for (const [, n] of cand) {
      if (pk.z - this.floor[n] > S.STEP_MAX) continue;
      probe.x = this.cx(n); probe.y = this.cy(n); probe.z = this.floor[n]; probe.vx = probe.vy = 0;
      S.moveCircle(this.prep, probe, pk.x - probe.x, pk.y - probe.y);
      if (Math.hypot(probe.x - pk.x, probe.y - pk.y) < 4) return n;
    }
    return -1;
  }
  cx(n) { return this.minX + (n % this.gw) * STEP; }
  cy(n) { return this.minY + Math.floor(n / this.gw) * STEP; }
  // BFS over reversed edges: out[n] = number of steps from n to goal
  field(goal, out) {
    out = out || new Uint16Array(this.N); out.fill(INF);
    if (goal < 0) return out;
    const q = this.q2; let qh = 0, qt = 0; out[goal] = 0; q[qt++] = goal;
    while (qh < qt) {
      const b = q[qh++], bx = b % this.gw, by = Math.floor(b / this.gw), nd = out[b] + 1;
      for (let d = 0; d < 8; d++) {
        const ax = bx - DIRS[d][0], ay = by - DIRS[d][1]; if (ax < 0 || ay < 0 || ax >= this.gw || ay >= this.gh) continue;
        const a = ay * this.gw + ax;
        if (out[a] !== INF || !(this.edges[a] & (1 << d))) continue;
        out[a] = nd; q[qt++] = a;
      }
    }
    return out;
  }
  // direction index of the best neighbour of n in the field, or -1
  descend(field, n) {
    const bx = n % this.gw, by = Math.floor(n / this.gw); let best = -1, bv = field[n];
    for (let d = 0; d < 8; d++) {
      if (!(this.edges[n] & (1 << d))) continue;
      const m = (by + DIRS[d][1]) * this.gw + bx + DIRS[d][0];
      if (field[m] < bv) { bv = field[m]; best = d; }
    }
    return best;
  }
}

const itemValue = (type, p) => {
  const it = ITEMS[type]; if (!it) return 0;
  if (it.weapon !== undefined) { const d = WEAPONS[it.weapon]; return (p.owned & (1 << it.weapon)) ? (p.ammo[d.ammoType] < AMMO_MAX[d.ammoType] * 0.6 ? 0.35 : 0.08) : 1.2; }
  if (it.ammo) return p.ammo[it.ammo[0]] < AMMO_MAX[it.ammo[0]] ? 0.25 + 0.5 * (1 - p.ammo[it.ammo[0]] / AMMO_MAX[it.ammo[0]]) : 0;
  let v = 0;
  if (it.health && p.health < it.max) v += 0.25 + (1 - p.health / 100) * 1.3;
  if (it.armorAdd && p.armor < it.max) v += 0.25;
  if (it.armorSet && p.armor < it.armorSet) v += 0.6 + (p.armorType < it.type ? 0.3 : 0);
  return v;
};
// weapon preference by range (higher = better)
const weaponScore = (id, dist) => {
  switch (id) {
    case 6: return dist > 350 ? 6 : 1;
    case 4: return dist > 180 ? 8 : 1;
    case 5: return 7;
    case 3: return dist > 300 ? 7.5 : 5;
    case 2: return dist < 500 ? 9 : 4;
    case 1: return dist < 600 ? 6.5 : 3;
    default: return 2;
  }
};

export class BotManager {
  // skill 0..1
  constructor(host, { ids = [], skill = 0.55, names = null } = {}) {
    this.host = host; this.skill = skill; this.bots = []; this.fields = new Map();
    this.nav = new Nav(host.world);
    this.names = {};
    ids.forEach((id, i) => this.add(id, names ? names[i] : NAMES[i % NAMES.length]));
  }
  add(id, name) {
    const peer = this.host.addPeer(id, true);
    this.names[id] = name;
    this.bots.push({ id, peer, yaw: 0, pitch: 0, goalItem: -1, field: new Uint16Array(this.nav.N), fieldFor: -2, fieldT: -1e9,
      enemy: -1, seenAt: -1e9, lastSeen: { x: 0, y: 0 }, noiseYaw: 0, noisePitch: 0, noiseT: 0, strafe: 1, strafeT: 0,
      escT: 0, escNode: -1, goalT: 0, ban: {}, stuckT: 0, lastX: 0, lastY: 0, unstick: 0, wantW: 0, wT: 0, fire: 0, acq: 0, wander: -1, dirX: 0, dirY: 0, thinkAt: Math.floor(Math.random() * 6),
      inited: false });
  }
  itemField(i) {
    let f = this.fields.get(i);
    if (!f) { const pk = this.host.world.pickups[i]; f = this.nav.field(this.nav.itemNode(pk)); this.fields.set(i, f); }
    return f;
  }
  // called once per host tick, before the sim step
  think() {
    const w = this.host.world;
    for (const b of this.bots) {
      const p = w.players[b.id]; if (!p) continue;
      if (!b.inited) { b.yaw = p.yaw; b.inited = true; }
      const raw = p.alive ? this.act(b, p, w) : NEUTRAL;
      b.peer.queue.push(S.quantizeInput({ ...raw, seq: ++b.peer.localSeq, viewTick: w.tick }));
    }
  }
  act(b, p, w) {
    const nav = this.nav, sk = this.skill, tick = w.tick;
    const ex = p.x, ey = p.y, ez = p.z + S.EYE;
    // ---------- perception + goal choice at ~10 Hz
    if (tick >= b.thinkAt) {
      b.thinkAt = tick + 6;
      let best = null, bd = 1e9;
      for (const id in w.players) {
        const o = w.players[id]; if (o === p || !o.alive) continue;
        const dx = o.x - ex, dy = o.y - ey, dz = o.z + 40 - ez, d = Math.hypot(dx, dy, dz);
        if (d > 2200 || d >= bd) continue;
        const r = S.traceRay(w, ex, ey, ez, dx / d, dy / d, dz / d, d + 8, p.id, null);
        if (r.kind === 'player' && r.target === o.id) { bd = d; best = o; }
      }
      if (best) {
        if (b.enemy !== best.id) { b.enemy = best.id; b.acq = tick + Math.round(30 * (1 - sk) + 8); }
        b.seenAt = tick; b.lastSeen.x = best.x; b.lastSeen.y = best.y;
      } else if (tick - b.seenAt > 90) b.enemy = -1;
      // weapon choice
      if (tick >= b.wT && p.wstate === 0) {
        b.wT = tick + 40;
        let bw = p.weapon, bs = -1;
        for (const d of WEAPONS) {
          if (!(p.owned & (1 << d.id)) || p.ammo[d.ammoType] < d.cost) continue;
          const sc = weaponScore(d.id, best ? bd : 600) + Math.random() * 0.5;
          if (sc > bs) { bs = sc; bw = d.id; }
        }
        b.wantW = bw !== p.weapon ? bw + 1 : 0;
      }
      // movement goal
      b.hunt = false;
      if (b.enemy < 0 || tick - b.seenAt > 15) {
        const chase = tick - b.seenAt < 240 && b.seenAt > 0;
        if (chase) { if (b.fieldFor !== -3 || tick - b.fieldT > 30) { nav.field(nav.nodeAt(b.lastSeen.x, b.lastSeen.y), b.field); b.fieldFor = -3; b.fieldT = tick; } b.hunt = true; }
        else {
          // pick the most useful reachable item (distance fields are built lazily, a few per think)
          const here = nav.nodeAt(p.x, p.y);
          if (b.goalItem >= 0) {
            const pk = w.pickups[b.goalItem];
            if (!pk.active || Math.hypot(pk.x - p.x, pk.y - p.y) < 30) b.goalItem = -1;
            else if (tick - b.goalT > 1500) { b.ban[b.goalItem] = tick + 3600; b.goalItem = -1; }   // not getting there: try something else for a while
          }
          if (b.goalItem < 0 && here >= 0) {
            let built = 0, bi = -1, bv = 0.02;
            w.pickups.forEach((pk, i) => {
              if (!pk.active || b.ban[i] > tick) return;
              let f = this.fields.get(i);
              if (!f) { if (built >= 3) return; f = this.itemField(i); built++; }
              const steps = f[here]; if (steps === INF) return;
              const v = (itemValue(pk.type, p) + Math.random() * 0.15) / (1 + steps * STEP / 900);
              if (v > bv) { bv = v; bi = i; }
            });
            b.goalItem = bi; b.goalT = tick;
          }
        }
      }
    }
    // ---------- targets
    const en = b.enemy >= 0 ? w.players[b.enemy] : null;
    const engaged = en && en.alive && tick - b.seenAt <= 15;
    let mx = 0, my = 0, aimYaw = b.yaw, aimPitch = 0, fire = 0;
    const wdef = WEAPONS[p.weapon];
    if (engaged) {
      let tx = en.x, ty = en.y, tz = en.z + 38;
      const dist = Math.hypot(tx - ex, ty - ey);
      if (wdef.kind === 'projectile') { const t = dist / wdef.proj.speed * sk; tx += en.vx * t; ty += en.vy * t; if (p.weapon === 4) tz = en.z + 6; }
      if (tick >= b.noiseT) { b.noiseT = tick + 14; const n = 0.1 * (1 - sk) + 0.012; b.noiseYaw = (Math.random() * 2 - 1) * n; b.noisePitch = (Math.random() * 2 - 1) * n * 0.6; }
      aimYaw = Math.atan2(ty - ey, tx - ex) + b.noiseYaw;
      aimPitch = Math.atan2(tz - ez, Math.hypot(tx - ex, ty - ey)) + b.noisePitch;
      // movement: keep a fighting distance, strafe
      if (tick >= b.strafeT) { b.strafeT = tick + 30 + Math.floor(Math.random() * 50); b.strafe = Math.random() < 0.5 ? -1 : 1; }
      const toX = (tx - ex) / (dist || 1), toY = (ty - ey) / (dist || 1);
      const want = p.weapon === 4 || p.weapon === 6 ? 380 : p.weapon === 2 || p.weapon === 1 ? 220 : 340;
      const fw = dist > want + 60 ? 1 : dist < want - 80 ? -0.7 : 0;
      mx = toX * fw + toY * -b.strafe * 0.9; my = toY * fw + toX * b.strafe * 0.9;
      // fire when roughly on target, after the reaction delay
      const err = Math.abs(angDiff(aimYaw, b.yaw));
      const tol = clamp(0.045 + 40 / (dist + 200) * 0.05 + (1 - sk) * 0.05, 0.04, 0.2);
      const rangeOk = wdef.kind === 'projectile' ? dist > (p.weapon === 5 ? 60 : 150) : dist < (wdef.range || 2000) * 0.7;
      if (tick >= b.acq && err < tol && rangeOk) fire = wdef.auto ? 1 : (tick & 1);
    } else if (b.hunt || b.goalItem >= 0) {
      const field = b.hunt ? b.field : this.itemField(b.goalItem);
      const here = nav.nodeAt(p.x, p.y);
      if (here >= 0) {
        const d = nav.descend(field, here);
        if (d >= 0) {
          // aim a node ahead for smooth corners
          const m = here + DIRS[d][1] * nav.gw + DIRS[d][0], d2 = nav.descend(field, m);
          let tx = nav.cx(m), ty = nav.cy(m);
          if (d2 >= 0) { tx += DIRS[d2][0] * STEP * 0.5; ty += DIRS[d2][1] * STEP * 0.5; }
          const L = Math.hypot(tx - p.x, ty - p.y) || 1; mx = (tx - p.x) / L; my = (ty - p.y) / L;
        } else if (b.goalItem >= 0 && !b.hunt) {
          const pk = w.pickups[b.goalItem]; const L = Math.hypot(pk.x - p.x, pk.y - p.y) || 1; mx = (pk.x - p.x) / L; my = (pk.y - p.y) / L;
          if (L < 40) b.goalItem = -1;
        } else b.seenAt = -1e9;
      } else if (b.goalItem >= 0) b.goalItem = -1;
      if (mx || my) aimYaw = Math.atan2(my, mx);
    } else if (nav.count > 1) {
      // nothing useful nearby: wander to a random node
      const here = nav.nodeAt(p.x, p.y);
      if (b.wander < 0 || nav.nodeAt(nav.cx(b.wander), nav.cy(b.wander)) === here) {
        b.wander = nav.nodes[Math.floor(Math.random() * nav.nodes.length)]; nav.field(b.wander, b.field);
      }
      const d = here >= 0 ? nav.descend(b.field, here) : -1;
      if (d >= 0) { mx = DIRS[d][0]; my = DIRS[d][1]; const L = Math.hypot(mx, my); mx /= L; my /= L; aimYaw = Math.atan2(my, mx); } else b.wander = -1;
    }
    // ---------- trapped (spawned on an isolated ledge / between nav nodes): walk straight out to the nearest connected node
    if (!engaged && !mx && !my && nav.count > 1) {
      const here = nav.nodeAt(p.x, p.y);
      if (here < 0 || !nav.hub[here]) {
        if (tick >= b.escT) { b.escT = tick + 30; b.escNode = nav.nearestHub(p.x, p.y, p.z); }
        if (b.escNode >= 0) {
          const tx = nav.cx(b.escNode) - p.x, ty = nav.cy(b.escNode) - p.y, L = Math.hypot(tx, ty);
          if (L > 12) { mx = tx / L; my = ty / L; aimYaw = Math.atan2(my, mx); } else b.escT = 0;
        }
      }
    }
    // ---------- stuck handling
    if (tick % 45 === 0) {
      if ((mx || my) && Math.hypot(p.x - b.lastX, p.y - b.lastY) < 10) { b.unstick = tick + 40; b.strafe = -b.strafe; if (b.goalItem >= 0 && Math.random() < 0.5) b.goalItem = -1; b.wander = -1; }
      b.lastX = p.x; b.lastY = p.y;
    }
    let jump = 0;
    if (tick < b.unstick) { const a = Math.atan2(my, mx) + b.strafe * 1.2; mx = Math.cos(a); my = Math.sin(a); jump = tick % 20 === 0 ? 1 : 0; }
    else if (engaged && Math.random() < 0.004) jump = 1;
    // ---------- view: turn-rate limited
    const maxTurn = (3.5 + 6 * sk) * S.DT * (engaged ? 1.4 : 0.7);
    b.yaw += clamp(angDiff(aimYaw, b.yaw), -maxTurn, maxTurn);
    b.pitch += clamp(aimPitch - b.pitch, -maxTurn, maxTurn);
    b.pitch = clamp(b.pitch, -1.2, 1.2); if (!engaged) b.pitch *= 0.9;
    const cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
    const out = RAW;
    out.fwd = mx * cy + my * sy; out.side = mx * sy - my * cy;
    out.yaw = b.yaw; out.pitch = b.pitch;
    out.buttons = (fire ? S.BTN.FIRE : 0) | (jump ? S.BTN.JUMP : 0) | (engaged && !(mx || my) ? 0 : S.BTN.SPRINT);
    out.weapon = b.wantW; if (b.wantW) b.wantW = p.wstate === 0 ? b.wantW : 0;
    return out;
  }
}
const NEUTRAL = { fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
const RAW = { fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
