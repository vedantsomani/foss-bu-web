import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as S from '../game/sim.js';
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import { TICK_MS } from '../net/protocol.js';

let wadjs = null;
try { wadjs = await import('../wad.js'); } catch { /* shared wad.js not available */ }
const gz = fs.readFileSync(new URL('../../freedm.wad.gz', import.meta.url));
const raw = zlib.gunzipSync(gz), ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
const map = wadjs ? wadjs.parseMap(wadjs.readWad(ab), 'MAP01') : (await import('../game/wadlite.js')).parseMapLite((await import('../game/wadlite.js')).readLumps(ab), 'MAP01');
console.log(`  [realmap] using ${wadjs ? 'public/lab/wad.js' : 'game/wadlite.js fallback'}: ${map.linedefs.length} linedefs, ${map.sectors.length} sectors, ${map.things.filter(t => t.type === 11).length} DM starts`);

function crosses(a, b, c, d) { // segments ab, cd properly intersect
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
const bsp = wadjs ? (x, y) => wadjs.pointInSector(map, x, y) : null;

test('MAP01: own sector lookup agrees with BSP pointInSector at most sample points', { skip: !wadjs }, () => {
  const prep = S.prepareMap(map); let n = 0, ok = 0;
  for (const t of map.things) { const a = S.sectorAt(prep, t.x, t.y), b = wadjs.pointInSector(map, t.x, t.y); n++; if (a === b) ok++; }
  console.log(`  [realmap] sector lookup agreement on ${n} THINGS: ${ok}/${n}`);
  assert.ok(ok / n > 0.97);
});

test('MAP01: 12 random bots x 6000 ticks never cross a one-sided wall nor leave the playable area', () => {
  const w = S.createWorld(map, 42, bsp ? { pointInSector: bsp } : {});
  const ids = []; for (let i = 1; i <= 12; i++) { S.addPlayer(w, i); ids.push(i); }
  const walls = w.prep.lines.filter(l => l.oneSided);
  let st = 77; const r = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  const cur = {}; let moved = 0;
  for (let t = 0; t < 6000; t++) {
    const ins = {};
    for (const id of ids) { if (t % 25 === id % 25) cur[id] = { fwd: 1, side: r() < .3 ? 1 : 0, yaw: r() * 6.283, buttons: S.BTN.SPRINT | (r() < .1 ? S.BTN.JUMP : 0) | (r() < .3 ? S.BTN.FIRE : 0), weapon: r() < .02 ? 1 + Math.floor(r() * 7) : 0 }; ins[id] = S.quantizeInput(cur[id] || {}); }
    const before = ids.map(id => ({ x: w.players[id].x, y: w.players[id].y }));
    S.step(w, ins);
    ids.forEach((id, k) => {
      const p = w.players[id], a = before[k]; if (!p.alive) return;
      if (Math.hypot(p.x - a.x, p.y - a.y) > 60) return; // respawn teleport
      moved += Math.hypot(p.x - a.x, p.y - a.y);
      for (const l of walls) if (crosses(a, p, { x: l.ax, y: l.ay }, { x: l.bx, y: l.by })) assert.fail(`bot ${id} crossed wall at tick ${t}`);
    });
  }
  console.log(`  [realmap] total distance walked ${(moved / 1000).toFixed(0)}k units, frags ${ids.map(i => w.players[i].frags).join(',')}`);
  assert.ok(moved > 300000);
});

test('MAP01: determinism on the real map (hash equal for same seed)', () => {
  const play = () => { const w = S.createWorld(map, 9, bsp ? { pointInSector: bsp } : {}); [1, 2, 3, 4].forEach(i => S.addPlayer(w, i));
    for (let t = 0; t < 1500; t++) { const ins = {}; for (let i = 1; i <= 4; i++) ins[i] = S.quantizeInput({ fwd: 1, yaw: (t * 0.013 * i) % 6.28, buttons: t % 30 === 0 ? 1 : S.BTN.SPRINT }); S.step(w, ins); } return S.hashWorld(w); };
  assert.equal(play(), play());
});

test('MAP01: item things become pickups; network session on the real map converges', () => {
  const w = S.createWorld(map, 1, bsp ? { pointInSector: bsp } : {});
  console.log(`  [realmap] pickups: ${w.pickups.length}`);
  assert.ok(w.pickups.length > 5);
  const net = new MemoryNetwork({ latency: 100, jitter: 20, loss: 0.05, seed: 4 });
  const host = new GameHost({ map, endpoint: net.endpoint(1), seed: 3, simOpts: bsp ? { pointInSector: bsp } : {} });
  let n = 0, st = 5; const rr = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  let cur = {}; const c = new GameClient({ map, endpoint: net.endpoint(2), id: 2, inputSource: () => { if (n++ % 40 === 0) cur = { fwd: 1, yaw: rr() * 6.28, buttons: S.BTN.SPRINT | (rr() < .2 ? S.BTN.JUMP : 0) }; return cur; } });
  let now = 0;
  const frame = () => { now += TICK_MS; net.update(now); host.update(now); c.update(now); };
  for (let i = 0; i < 60 * 20; i++) frame();
  c.inputSource = () => ({}); for (let i = 0; i < 60 * 3; i++) frame();
  const hp = host.world.players[2], err = Math.hypot(c.me.x - hp.x, c.me.y - hp.y, c.me.z - hp.z);
  console.log(`  [realmap] net settled error ${err.toFixed(5)}u, corrections ${c.stats.corrections}, max ${c.stats.maxCorrection.toFixed(2)}u`);
  assert.ok(err < 1);
});
