/*
 * wad.js - shared Doom WAD + map loader (plain ES module, no dependencies).
 *
 *   fetchWad(url)            fetch + gunzip (if the URL ends in .gz or the data starts with 1f 8b) -> Wad
 *   readWad(arrayBuffer)     -> Wad
 *   Wad = { lumps:[{name,offset,size}], has(name), lump(name)->Uint8Array|null, lumpIndex(name)->int (-1 if none),
 *           lumpAt(index)->Uint8Array, buffer }
 *     Names are upper-case. When a name occurs more than once the LAST lump wins (PWAD override rule).
 *   parseMap(wad, 'MAP01')   -> MapData, raw Doom units, y up exactly as stored in the WAD:
 *     vertices : [{x, y}]
 *     linedefs : [{v1, v2, flags, special, tag, front, back}]   front/back = sidedef index or -1
 *     sidedefs : [{xoff, yoff, upper, lower, middle, sector}]   texture names, '-' = none
 *     sectors  : [{floor, ceil, floorTex, ceilTex, light, special, tag}]
 *     things   : [{x, y, angle, type, flags}]                   angle in degrees as in the WAD
 *     segs     : [{v1, v2, angle, linedef, side, offset}]       side 0 = front, 1 = back of the linedef
 *     subsectors: [{count, first}]
 *     nodes    : [{x, y, dx, dy, bboxRight:[top,bottom,left,right], bboxLeft:[...], right, left}]
 *                right/left = child; if (child & 0x8000) it is a subsector index (child & 0x7fff).
 *                Root node is nodes[nodes.length-1].
 *   pointInSector(map, x, y) -> sector index (walks the BSP nodes), -1 if the map has no subsectors.
 */

const td = new TextDecoder('latin1');

function lumpName(u8, o) {
  let e = o;
  while (e < o + 8 && u8[e] !== 0) e++;
  return td.decode(u8.subarray(o, e)).toUpperCase();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetchWad: HTTP ' + res.status + ' for ' + url);
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
    buf = await ds.arrayBuffer();
  }
  return buf;
}
export async function fetchWad(url) { return readWad(await fetchBuffer(url)); }

// Load an IWAD and lay PWADs over it (the standard Doom rule: a patch lump replaces the base lump of the same name).
// A missing PWAD is not an error. Returns a Wad (readWad) of the merged data.
export async function fetchWadStack(iwadUrl, pwadUrls = []) {
  let buf = await fetchBuffer(iwadUrl);
  const patched = new Set();
  for (const u of pwadUrls) {
    try { const pb = await fetchBuffer(u); buf = mergeWads(buf, pb); for (const l of readWad(pb).lumps) patched.add(l.name); } catch { /* optional patch not available */ }
  }
  const wad = readWad(buf); wad.patchNames = patched;   // which lumps came from a PWAD (branding lumps are only trusted from there)
  return wad;
}

const MAP_LUMP = /^(MAP\d\d|E\dM\d|THINGS|LINEDEFS|SIDEDEFS|VERTEXES|SEGS|SSECTORS|NODES|SECTORS|REJECT|BLOCKMAP|[A-Z]{1,2}_(START|END))$/;
// mergeWads(baseBuf, patchBuf) -> ArrayBuffer of a new IWAD. Patch lumps replace same-named base lumps in place (so first-match and
// last-match readers agree); new names, map data and markers are appended.
export function mergeWads(baseBuf, patchBuf) {
  const a = readWad(baseBuf), b = readWad(patchBuf);
  const out = a.lumps.map((l, i) => ({ name: l.name, data: a.lumpAt(i) }));
  const first = new Map(); out.forEach((l, i) => { if (!first.has(l.name)) first.set(l.name, i); });
  b.lumps.forEach((l, i) => {
    const data = b.lumpAt(i);
    if (!MAP_LUMP.test(l.name) && first.has(l.name)) out[first.get(l.name)] = { name: l.name, data };
    else out.push({ name: l.name, data });
  });
  let total = 12; for (const l of out) total += l.data.length;
  const buf = new ArrayBuffer(total + out.length * 16), u8 = new Uint8Array(buf), dv = new DataView(buf);
  u8.set([0x49, 0x57, 0x41, 0x44]); dv.setInt32(4, out.length, true); dv.setInt32(8, total, true);
  let off = 12;
  out.forEach((l, i) => {
    u8.set(l.data, off);
    const d = total + i * 16; dv.setInt32(d, off, true); dv.setInt32(d + 4, l.data.length, true);
    for (let k = 0; k < 8; k++) u8[d + 8 + k] = k < l.name.length ? l.name.charCodeAt(k) : 0;
    off += l.data.length;
  });
  return buf;
}

export function readWad(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const id = td.decode(u8.subarray(0, 4));
  if (id !== 'IWAD' && id !== 'PWAD') throw new Error('readWad: bad header ' + id);
  const num = dv.getInt32(4, true);
  const dir = dv.getInt32(8, true);
  const lumps = new Array(num);
  const byName = new Map();
  for (let i = 0; i < num; i++) {
    const o = dir + i * 16;
    lumps[i] = { name: lumpName(u8, o + 8), offset: dv.getInt32(o, true), size: dv.getInt32(o + 4, true) };
    byName.set(lumps[i].name, i);
  }
  const wad = {
    lumps,
    buffer: arrayBuffer,
    has: (name) => byName.has(name.toUpperCase()),
    lumpIndex: (name) => { const i = byName.get(name.toUpperCase()); return i === undefined ? -1 : i; },
    lumpAt: (i) => u8.subarray(lumps[i].offset, lumps[i].offset + lumps[i].size),
    lump(name) { const i = byName.get(name.toUpperCase()); return i === undefined ? null : wad.lumpAt(i); },
  };
  return wad;
}

export function parseMap(wad, mapName) {
  const base = wad.lumpIndex(mapName);
  if (base < 0) throw new Error('parseMap: no such map ' + mapName);
  const found = {};
  for (let i = base + 1; i < Math.min(base + 14, wad.lumps.length); i++) {
    const n = wad.lumps[i].name;
    if (/^(MAP\d\d|E\dM\d)$/.test(n)) break;
    found[n] = wad.lumpAt(i);
  }
  const view = (n) => {
    const u = found[n];
    if (!u) return { dv: new DataView(new ArrayBuffer(0)), len: 0, u8: new Uint8Array(0) };
    return { dv: new DataView(u.buffer, u.byteOffset, u.byteLength), len: u.byteLength, u8: u };
  };
  const idx = (v) => (v === 0xffff ? -1 : v);

  let m = view('VERTEXES');
  const vertices = [];
  for (let o = 0; o + 4 <= m.len; o += 4) vertices.push({ x: m.dv.getInt16(o, true), y: m.dv.getInt16(o + 2, true) });

  m = view('LINEDEFS');
  const linedefs = [];
  for (let o = 0; o + 14 <= m.len; o += 14) {
    linedefs.push({
      v1: m.dv.getUint16(o, true), v2: m.dv.getUint16(o + 2, true), flags: m.dv.getUint16(o + 4, true),
      special: m.dv.getUint16(o + 6, true), tag: m.dv.getUint16(o + 8, true),
      front: idx(m.dv.getUint16(o + 10, true)), back: idx(m.dv.getUint16(o + 12, true)),
    });
  }

  m = view('SIDEDEFS');
  const sidedefs = [];
  for (let o = 0; o + 30 <= m.len; o += 30) {
    sidedefs.push({
      xoff: m.dv.getInt16(o, true), yoff: m.dv.getInt16(o + 2, true),
      upper: lumpName(m.u8, o + 4), lower: lumpName(m.u8, o + 12), middle: lumpName(m.u8, o + 20),
      sector: m.dv.getUint16(o + 28, true),
    });
  }

  m = view('SECTORS');
  const sectors = [];
  for (let o = 0; o + 26 <= m.len; o += 26) {
    sectors.push({
      floor: m.dv.getInt16(o, true), ceil: m.dv.getInt16(o + 2, true),
      floorTex: lumpName(m.u8, o + 4), ceilTex: lumpName(m.u8, o + 12),
      light: m.dv.getInt16(o + 20, true), special: m.dv.getInt16(o + 22, true), tag: m.dv.getInt16(o + 24, true),
    });
  }

  m = view('THINGS');
  const things = [];
  for (let o = 0; o + 10 <= m.len; o += 10) {
    things.push({
      x: m.dv.getInt16(o, true), y: m.dv.getInt16(o + 2, true), angle: m.dv.getInt16(o + 4, true),
      type: m.dv.getInt16(o + 6, true), flags: m.dv.getInt16(o + 8, true),
    });
  }

  m = view('SEGS');
  const segs = [];
  for (let o = 0; o + 12 <= m.len; o += 12) {
    segs.push({
      v1: m.dv.getUint16(o, true), v2: m.dv.getUint16(o + 2, true), angle: m.dv.getInt16(o + 4, true),
      linedef: m.dv.getUint16(o + 6, true), side: m.dv.getInt16(o + 8, true), offset: m.dv.getInt16(o + 10, true),
    });
  }

  m = view('SSECTORS');
  const subsectors = [];
  for (let o = 0; o + 4 <= m.len; o += 4) subsectors.push({ count: m.dv.getUint16(o, true), first: m.dv.getUint16(o + 2, true) });

  m = view('NODES');
  const nodes = [];
  for (let o = 0; o + 28 <= m.len; o += 28) {
    const g = (k) => m.dv.getInt16(o + k, true);
    nodes.push({
      x: g(0), y: g(2), dx: g(4), dy: g(6),
      bboxRight: [g(8), g(10), g(12), g(14)], bboxLeft: [g(16), g(18), g(20), g(22)],
      right: m.dv.getUint16(o + 24, true), left: m.dv.getUint16(o + 26, true),
    });
  }

  return { name: mapName.toUpperCase(), vertices, linedefs, sidedefs, sectors, things, segs, subsectors, nodes };
}

export function pointInSector(map, x, y) {
  const { nodes, subsectors, segs, linedefs, sidedefs } = map;
  if (!subsectors.length) return -1;
  let child = nodes.length ? nodes.length - 1 : 0x8000;
  while (!(child & 0x8000)) {
    const n = nodes[child];
    const side = (n.dx * (y - n.y) - n.dy * (x - n.x)) < 0 ? 0 : 1; // 0 = right/front of partition line
    child = side ? n.left : n.right;
  }
  const ss = subsectors[child === 0xffff ? 0 : child & 0x7fff];
  const seg = segs[ss.first];
  if (!seg) return -1;
  const ld = linedefs[seg.linedef];
  const sd = seg.side ? ld.back : ld.front;
  return sidedefs[sd].sector;
}
