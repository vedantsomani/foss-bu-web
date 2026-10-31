import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as G from '../render/gfx.js';
import { Registry, buildGeometry, FLOATS_PER_VERTEX as F, dynamicSectors } from '../render/geometry.js';
import * as wadjs from '../wad.js';

const raw = zlib.gunzipSync(fs.readFileSync(new URL('../../freedm.wad.gz', import.meta.url)));
const wad = wadjs.readWad(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const texDefs = G.loadTextureDefs(wad), flatIndex = G.loadFlatIndex(wad);
const regs = () => [new Registry(n => { const d = texDefs.get(n); return d && d.w > 0 && d.h > 0 ? { w: d.w, h: d.h } : null; }, []), new Registry(n => (flatIndex.has(n) ? { w: 64, h: 64 } : null), [])];

test('geometry: every FreeDM map builds; units index valid ranges; height slots, anchors and z extents are consistent', () => {
  let maps = 0, dynTotal = 0;
  for (let n = 1; n <= 32; n++) {
    const name = 'MAP' + String(n).padStart(2, '0');
    if (wad.lumpIndex(name) < 0) continue;
    const map = wadjs.parseMap(wad, name), [wr, fr] = regs();
    const g = buildGeometry(map, wr, fr), nsec = map.sectors.length;
    assert.equal(g.nUnits, map.linedefs.length * 2 + map.subsectors.length);
    for (const k of Object.keys(g.batches)) {
      const b = g.batches[k], nv = b.vertices.length / F;
      assert.equal(b.ranges.length, g.nUnits * 2);
      let covered = 0;
      for (let u = 0; u < g.nUnits; u++) { const st = b.ranges[u * 2], ct = b.ranges[u * 2 + 1]; assert.ok(st + ct <= b.indices.length); covered += ct; }
      assert.equal(covered, b.indices.length, name + ' ' + k + ' ranges cover every index');
      for (let i = 0; i < b.indices.length; i++) assert.ok(b.indices[i] < nv);
      for (let v = 0; v < nv; v++) {
        for (let c = 0; c < F; c++) assert.ok(Number.isFinite(b.vertices[v * F + c]), name + ' finite');
        const bind = b.vertices[v * F + 8], other = b.vertices[v * F + 10];
        assert.ok(bind === -1 || (bind >= 0 && bind < nsec * 2 && Number.isInteger(bind)));
        assert.ok(other === 0 || (other >= 1 && other <= nsec * 2));
      }
    }
    // z entries: every sector has a (bind, min<=max) list
    for (let s = 0; s < nsec; s++) for (let e = g.zStart[s]; e < g.zStart[s + 1]; e++) assert.ok(g.zData[e * 3 + 1] <= g.zData[e * 3 + 2]);
    maps++; dynTotal += dynamicSectors(map).reduce((a, b) => a + b, 0);
  }
  assert.equal(maps, 32); assert.ok(dynTotal > 20);
});

test('geometry: a door sector gets live-height slots on its upper wall; closed doors collapse (top clamped to the bottom)', () => {
  const map = wadjs.parseMap(wad, 'MAP01'), [wr, fr] = regs();
  const li = map.linedefs.findIndex(l => l.special === 117 || l.special === 1);
  const L = map.linedefs[li], doorSec = map.sidedefs[L.back].sector, roomSec = map.sidedefs[L.front].sector;
  const g = buildGeometry(map, wr, fr), b = g.batches.wall;
  const st = b.ranges[(li * 2) * 2], ct = b.ranges[(li * 2) * 2 + 1];
  assert.ok(ct > 0, 'room-side face has quads');
  const slots = new Set();
  for (let i = st; i < st + ct; i++) slots.add(b.vertices[b.indices[i] * F + 8]);
  assert.ok(slots.has(doorSec * 2 + 1) && slots.has(roomSec * 2 + 1), 'upper wall: bottom follows the door ceiling, top the room ceiling');
});
