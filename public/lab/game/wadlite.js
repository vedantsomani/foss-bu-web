// wadlite.js - tiny self-contained WAD reader used ONLY for (a) weapon sprites + PLAYPAL for the
// viewmodel and (b) a fallback MapData parser when ../wad.js is not available.
// It produces the same MapData shape as the shared wad.js contract (without segs/subsectors/nodes).
const dec = new TextDecoder('latin1');
const name8 = (v, o) => dec.decode(new Uint8Array(v.buffer, v.byteOffset + o, 8)).replace(/\0.*$/, '').toUpperCase();

export function readLumps(buf) {
  const v = new DataView(buf);
  const n = v.getInt32(4, true), dir = v.getInt32(8, true);
  const lumps = [];
  for (let i = 0; i < n; i++) {
    const o = dir + i * 16;
    lumps.push({ name: name8(v, o + 8), off: v.getInt32(o, true), size: v.getInt32(o + 4, true) });
  }
  const byName = new Map();
  lumps.forEach((l, i) => { if (!byName.has(l.name)) byName.set(l.name, i); });
  return { buf, lumps, byName, view: v };
}
export const lumpData = (w, i) => new DataView(w.buf, w.lumps[i].off, w.lumps[i].size);

export function getPalette(w) {
  const i = w.byName.get('PLAYPAL');
  const d = new Uint8Array(w.buf, w.lumps[i].off, 768);
  return d;
}

// Decode a Doom picture lump to RGBA pixels.
export function decodePicture(w, lumpName, pal) {
  const i = w.byName.get(lumpName);
  if (i === undefined) return null;
  const v = lumpData(w, i);
  const width = v.getInt16(0, true), height = v.getInt16(2, true);
  const left = v.getInt16(4, true), top = v.getInt16(6, true);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    let p = v.getUint32(8 + x * 4, true);
    for (;;) {
      const td = v.getUint8(p++);
      if (td === 255) break;
      const len = v.getUint8(p++); p++;
      for (let k = 0; k < len; k++) {
        const c = v.getUint8(p + k), y = td + k;
        if (y >= height) continue;
        const o = (y * width + x) * 4;
        rgba[o] = pal[c * 3]; rgba[o + 1] = pal[c * 3 + 1]; rgba[o + 2] = pal[c * 3 + 2]; rgba[o + 3] = 255;
      }
      p += len + 1;
    }
  }
  return { name: lumpName, width, height, left, top, rgba };
}

// Minimal MapData parse (fallback only).
export function parseMapLite(w, mapName = 'MAP01') {
  const m = w.byName.get(mapName);
  if (m === undefined) throw new Error('no map ' + mapName);
  const get = nm => { for (let i = m + 1; i < m + 12; i++) if (w.lumps[i].name === nm) return lumpData(w, i); throw new Error('lump ' + nm); };
  const str = (v, o) => name8(v, o);
  const T = get('THINGS'), L = get('LINEDEFS'), S = get('SIDEDEFS'), V = get('VERTEXES'), C = get('SECTORS');
  const map = { vertices: [], linedefs: [], sidedefs: [], sectors: [], things: [], segs: [], subsectors: [], nodes: [] };
  for (let o = 0; o < V.byteLength; o += 4) map.vertices.push({ x: V.getInt16(o, true), y: V.getInt16(o + 2, true) });
  for (let o = 0; o < L.byteLength; o += 14) {
    const b = L.getInt16(o + 12, true);
    map.linedefs.push({ v1: L.getUint16(o, true), v2: L.getUint16(o + 2, true), flags: L.getUint16(o + 4, true),
      special: L.getUint16(o + 6, true), tag: L.getUint16(o + 8, true), front: L.getInt16(o + 10, true), back: b === -1 ? -1 : b });
  }
  for (let o = 0; o < S.byteLength; o += 30) map.sidedefs.push({ xoff: S.getInt16(o, true), yoff: S.getInt16(o + 2, true),
    upper: str(S, o + 4), lower: str(S, o + 12), middle: str(S, o + 20), sector: S.getInt16(o + 28, true) });
  for (let o = 0; o < C.byteLength; o += 26) map.sectors.push({ floor: C.getInt16(o, true), ceil: C.getInt16(o + 2, true),
    floorTex: str(C, o + 4), ceilTex: str(C, o + 12), light: C.getInt16(o + 20, true), special: C.getInt16(o + 22, true), tag: C.getInt16(o + 24, true) });
  for (let o = 0; o < T.byteLength; o += 10) map.things.push({ x: T.getInt16(o, true), y: T.getInt16(o + 2, true),
    angle: T.getInt16(o + 4, true), type: T.getInt16(o + 6, true), flags: T.getInt16(o + 8, true) });
  return map;
}

export async function fetchGz(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  if (!url.endsWith('.gz')) return r.arrayBuffer();
  const ds = r.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(ds).arrayBuffer();
}
