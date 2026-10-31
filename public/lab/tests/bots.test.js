// Bots must not idle forever: spawn alcoves higher than a drop, items behind walls, small isolated nav regions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as S from '../game/sim.js';
import { readWad, parseMap, pointInSector } from '../wad.js';
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { BotManager, Nav } from '../play/bots.js';

const raw = zlib.gunzipSync(fs.readFileSync(new URL('../../freedm.wad.gz', import.meta.url)));
const wad = readWad(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));

function longestIdle(mapName, seconds) {
  const map = parseMap(wad, mapName);
  const host = new GameHost({ map, endpoint: new MemoryNetwork().endpoint(1), seed: 5, localId: 1, simOpts: { pointInSector: (x, y) => pointInSector(map, x, y) } });
  const realRandom = Math.random; let seed = 777;
  Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  try {
    const ids = [2, 3, 4, 5], bm = new BotManager(host, { ids, skill: 0.55 }), w = host.world;
    const st = Object.fromEntries(ids.map(id => [id, { x: 0, y: 0, still: 0, max: 0 }]));
    for (let t = 0; t < seconds * 60; t++) {
      bm.think(); host.localInput({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 }); host.tick();
      if (t % 30) continue;
      for (const id of ids) {
        const p = w.players[id], s = st[id];
        if (!p.alive) { s.still = 0; continue; }
        if (Math.hypot(p.x - s.x, p.y - s.y) < 6) s.max = Math.max(s.max, ++s.still * 0.5); else s.still = 0;
        s.x = p.x; s.y = p.y;
      }
    }
    return Math.max(...ids.map(id => st[id].max));
  } finally { Math.random = realRandom; }
}

for (const m of ['MAP32', 'MAP19', 'MAP16']) {
  test(`bots (${m}): none idles for long (trapped spawn ledges, unreachable items)`, () => {
    const idle = longestIdle(m, 240);
    assert.ok(idle < 30, `a bot stood still for ${idle}s`);
  });
}

test('bots: nav marks a spawn alcove that is too high to drop from as a trap, and the main region as hub', () => {
  const map = parseMap(wad, 'MAP32'), w = S.createWorld(map, 1, { pointInSector: (x, y) => pointInSector(map, x, y) });
  const nav = new Nav(w);
  let hub = 0; for (const n of nav.nodes) hub += nav.hub[n];
  assert.ok(hub > nav.count * 0.9, `most nodes (${hub}/${nav.count}) can reach the main region`);
  assert.ok(hub < nav.count, 'but not all of them (isolated ledges exist on this map)');
});
