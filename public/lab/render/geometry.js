// geometry.js - builds static per-sector mesh data for a Doom map.
//
// Vertex layout (12 floats): x, y, z (Doom units, z up), u, v (texel units), texId (logical id), sector, lightAdj,
//   bind    : height slot this vertex follows (sector*2 + 0 floor | 1 ceiling) or -1 = fixed. The vertex shader adds
//             (live height - map height) of that slot to z, so doors/lifts need no geometry rebuild.
//   anchor  : height slot the texture row origin is pegged to (v += d(anchor) - d(bind)); -1 = fixed peg, <= -2 = leave v alone (flats)
//   other   : +(slot+1) on the TOP vertex of a quad whose bottom follows `slot` (-(slot+1) on the bottom vertex), 0 = none.
//   zo      : static z of that partner vertex. The top vertex is clamped to >= partner so a fully closed door collapses instead of inverting.
// Four batches (= four draw calls): wall (opaque/alpha-tested), masked (two-sided mid textures), flat, sky.
// Every batch keeps its indices grouped per "unit" so the renderer can build a front-to-back index list from a BSP walk:
//   unit = linedef*2 + side   for wall quads,   unit = 2*nLines + subsector   for floors/ceilings (flat batch and sky ceilings).

export const FLOATS_PER_VERTEX = 12;
export const fl = (s) => s * 2, ce = (s) => s * 2 + 1;

import { lineSpecialInfo } from '../game/sim.js';

const ML_TWOSIDED = 4, ML_DONTPEGTOP = 8, ML_DONTPEGBOTTOM = 16;

export class Registry {
  // lookup(name) -> {w,h} | null ; anims: array of [firstName,lastName] groups already expanded to frame lists
  constructor(lookup, animGroups) {
    this.lookup = lookup;
    this.ids = new Map();
    this.entries = [];
    this.groups = []; // arrays of ids that cycle together
    this.animOf = new Map();
    for (const g of animGroups) for (const n of g) this.animOf.set(n, g);
  }
  _add(name) {
    if (this.ids.has(name)) return this.ids.get(name);
    const info = this.lookup(name);
    if (!info) return -1;
    const id = this.entries.length;
    this.entries.push({ name, w: info.w, h: info.h });
    this.ids.set(name, id);
    return id;
  }
  use(name) {
    if (!name || name === '-') return -1;
    const g = this.animOf.get(name);
    if (g && !this.ids.has(name)) {
      const ids = g.map((n) => this._add(n));
      if (ids.every((i) => i >= 0)) this.groups.push(ids);
    }
    return this._add(name);
  }
  size(id) { return this.entries[id]; }
}

class Batch {
  constructor(nUnits) {
    this.u = new Array(nUnits);
    this.tris = 0;
  }
  vert(unit, x, y, z, u, v, tex, sec, adj, bind, anchor, other, zo) {
    const b = this.u[unit] || (this.u[unit] = { v: [], n: 0, i: [] });
    b.v.push(x, y, z, u, v, tex, sec, adj, bind, anchor, other, zo);
    return b.n++;
  }
  tri(unit, a, b, c) { this.u[unit].i.push(a, b, c); this.tris++; }
  finalize() {
    let nv = 0, ni = 0;
    for (const b of this.u) if (b) { nv += b.n; ni += b.i.length; }
    const vertices = new Float32Array(nv * FLOATS_PER_VERTEX);
    const indices = new Uint32Array(ni);
    const ranges = new Int32Array(this.u.length * 2);
    let vo = 0, io = 0;
    this.u.forEach((b, ui) => {
      if (!b) return;
      vertices.set(b.v, vo * FLOATS_PER_VERTEX);
      ranges[ui * 2] = io;
      for (let k = 0; k < b.i.length; k++) indices[io++] = b.i[k] + vo;
      ranges[ui * 2 + 1] = io - ranges[ui * 2];
      vo += b.n;
    });
    return { vertices, indices, ranges, triangles: ni / 3 };
  }
}

function clipPoly(poly, ox, oy, dx, dy, keepRight) {
  // keep the half-plane on the right (cross < 0) or left (cross > 0) of directed line o->o+d
  const n = poly.length;
  if (n < 3) return [];
  const out = [];
  const f = (p) => {
    const c = dx * (p[1] - oy) - dy * (p[0] - ox);
    return keepRight ? -c : c;
  };
  const EPS = 1e-6;
  let prev = poly[n - 1], fp = f(prev);
  for (let i = 0; i < n; i++) {
    const cur = poly[i], fc = f(cur);
    if (fc >= -EPS) {
      if (fp < -EPS) { const t = fp / (fp - fc); out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]); }
      out.push(cur);
    } else if (fp >= -EPS) {
      const t = fp / (fp - fc);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
    prev = cur; fp = fc;
  }
  return out;
}

// Convex polygon for every BSP subsector: world box clipped by ancestor partition lines, then by its own segs.
export function subsectorPolygons(map) {
  const { vertices, nodes, subsectors, segs } = map;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const v of vertices) { minx = Math.min(minx, v.x); miny = Math.min(miny, v.y); maxx = Math.max(maxx, v.x); maxy = Math.max(maxy, v.y); }
  const m = 32;
  const root = [[minx - m, miny - m], [maxx + m, miny - m], [maxx + m, maxy + m], [minx - m, maxy + m]];
  const polys = new Array(subsectors.length).fill(null);
  const rec = (child, poly) => {
    if (poly.length < 3) return;
    if (child & 0x8000) { const si = child === 0xffff ? 0 : child & 0x7fff; polys[si] = poly; return; }
    const nd = nodes[child];
    rec(nd.right, clipPoly(poly, nd.x, nd.y, nd.dx, nd.dy, true));
    rec(nd.left, clipPoly(poly, nd.x, nd.y, nd.dx, nd.dy, false));
  };
  if (nodes.length) rec(nodes.length - 1, root); else if (polys.length) polys[0] = root;
  for (let i = 0; i < subsectors.length; i++) {
    let p = polys[i];
    if (!p) continue;
    const ss = subsectors[i];
    for (let k = 0; k < ss.count && p.length >= 3; k++) {
      const sg = segs[ss.first + k];
      const a = vertices[sg.v1], b = vertices[sg.v2];
      if (!a || !b) continue;
      p = clipPoly(p, a.x, a.y, b.x - a.x, b.y - a.y, true);
    }
    polys[i] = p.length >= 3 ? p : null;
  }
  return polys;
}

// Sectors whose floor/ceiling can move: manual door back sectors and everything tagged by a door/lift/floor special.
export function dynamicSectors(map) {
  const dyn = new Uint8Array(map.sectors.length);
  const tagged = new Map();
  map.sectors.forEach((sc, i) => { if (sc.tag) (tagged.get(sc.tag) || tagged.set(sc.tag, []).get(sc.tag)).push(i); });
  for (const ld of map.linedefs) {
    const info = ld.special ? lineSpecialInfo(ld.special) : null;
    if (!info) continue;
    if (info.fam === 'mdoor') { if (ld.back >= 0) dyn[map.sidedefs[ld.back].sector] = 1; }
    else if ((info.fam === 'door' || info.fam === 'lift' || info.fam === 'perp' || info.fam === 'floor') && ld.tag && tagged.has(ld.tag)) for (const s of tagged.get(ld.tag)) dyn[s] = 1;
  }
  return dyn;
}

export function buildGeometry(map, wallReg, flatReg) {
  const nsec = map.sectors.length;
  const { vertices, linedefs, sidedefs, sectors } = map;
  const nl = linedefs.length, nss = map.subsectors.length, nUnits = nl * 2 + nss;
  const B = { wall: new Batch(nUnits), masked: new Batch(nUnits), flat: new Batch(nUnits), sky: new Batch(nUnits) };
  const dyn = dynamicSectors(map);
  // per-sector extents: xy box + z entries grouped by the height slot they follow (so live z-range = base range + live delta)
  const sbox = new Float32Array(nsec * 4);
  for (let i = 0; i < nsec; i++) { sbox[i * 4] = sbox[i * 4 + 1] = 1e9; sbox[i * 4 + 2] = sbox[i * 4 + 3] = -1e9; }
  const zent = Array.from({ length: nsec }, () => new Map());
  const touch = (s, x, y, z, bind) => {
    const o = s * 4;
    if (x < sbox[o]) sbox[o] = x; if (y < sbox[o + 1]) sbox[o + 1] = y; if (x > sbox[o + 2]) sbox[o + 2] = x; if (y > sbox[o + 3]) sbox[o + 3] = y;
    const e = zent[s].get(bind);
    if (!e) zent[s].set(bind, [z, z]); else { if (z < e[0]) e[0] = z; if (z > e[1]) e[1] = z; }
  };
  const isSky = (s) => s.ceilTex === 'F_SKY1';

  // quad between (x1,y1)->(x2,y2) from zb (follows bindB) to zt (follows bindT). topZ = world z at texture row 0 (v = topZ - z), pegged to `anchor`.
  // keepInverted: dynamic quads are emitted even when currently empty/inverted (the shader collapses them until they open).
  const quad = (batch, unit, sec, x1, y1, x2, y2, zb, zt, u0, topZ, tex, adj, bindB, bindT, anchor, keepInverted) => {
    if (!keepInverted && !(zt > zb)) return;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const u1 = u0 + len;
    const vt = topZ - zt, vb = topZ - zb;
    const oT = keepInverted && bindT >= 0 && bindB >= 0 ? bindB + 1 : 0;   // top vertices are clamped to the bottom's live height
    const a = batch.vert(unit, x1, y1, zb, u0, vb, tex, sec, adj, bindB, anchor, 0, 0);
    const b = batch.vert(unit, x2, y2, zb, u1, vb, tex, sec, adj, bindB, anchor, 0, 0);
    const c = batch.vert(unit, x2, y2, zt, u1, vt, tex, sec, adj, bindT, anchor, oT, zb);
    const d = batch.vert(unit, x1, y1, zt, u0, vt, tex, sec, adj, bindT, anchor, oT, zb);
    batch.tri(unit, a, b, c); batch.tri(unit, a, c, d);
    touch(sec, x1, y1, zb, bindB); touch(sec, x2, y2, zb, bindB); touch(sec, x2, y2, zt, bindT); touch(sec, x1, y1, zt, bindT);
  };

  linedefs.forEach((ld, li) => {
    const va = vertices[ld.v1], vb = vertices[ld.v2];
    if (!va || !vb) return;
    const adjBase = va.y === vb.y ? -16 : va.x === vb.x ? 16 : 0;
    for (let side = 0; side < 2; side++) {
      const sdi = side === 0 ? ld.front : ld.back;
      if (sdi < 0) continue;
      const osd = side === 0 ? ld.back : ld.front;
      const sd = sidedefs[sdi];
      const A = sectors[sd.sector], sec = sd.sector, unit = li * 2 + side;
      const [x1, y1, x2, y2] = side === 0 ? [va.x, va.y, vb.x, vb.y] : [vb.x, vb.y, va.x, va.y];
      const u0 = sd.xoff;
      if (osd < 0) {
        // one-sided: middle only
        const t = wallReg.use(sd.middle);
        if (t < 0) continue;
        const th = wallReg.size(t).h, dpb = (ld.flags & ML_DONTPEGBOTTOM) !== 0;
        const topZ = (dpb ? A.floor + th : A.ceil) + sd.yoff;
        quad(B.wall, unit, sec, x1, y1, x2, y2, A.floor, A.ceil, u0, topZ, t, adjBase, fl(sec), ce(sec), dpb ? fl(sec) : ce(sec), dyn[sec]);
        continue;
      }
      const osec = sidedefs[osd].sector, Bs = sectors[osec];
      const dl = dyn[sec] || dyn[osec];
      // lower
      if (Bs.floor > A.floor || dl) {
        const t = wallReg.use(sd.lower);
        if (t >= 0) {
          const dpb = (ld.flags & ML_DONTPEGBOTTOM) !== 0;
          const topZ = (dpb ? A.ceil : Bs.floor) + sd.yoff;
          quad(B.wall, unit, sec, x1, y1, x2, y2, A.floor, Bs.floor, u0, topZ, t, adjBase, fl(sec), fl(osec), dpb ? ce(sec) : fl(osec), dl);
        }
      }
      // upper
      if (Bs.ceil < A.ceil || dl) {
        if (isSky(A) && isSky(Bs)) {
          quad(B.sky, unit, sec, x1, y1, x2, y2, Bs.ceil, A.ceil, 0, A.ceil, 0, 0, ce(osec), ce(sec), -2, dl);
        } else {
          const t = wallReg.use(sd.upper);
          if (t >= 0) {
            const th = wallReg.size(t).h, dpt = (ld.flags & ML_DONTPEGTOP) !== 0;
            const topZ = (dpt ? A.ceil : Bs.ceil + th) + sd.yoff;
            quad(B.wall, unit, sec, x1, y1, x2, y2, Bs.ceil, A.ceil, u0, topZ, t, adjBase, ce(osec), ce(sec), dpt ? ce(sec) : ce(osec), dl);
          }
        }
      }
      // two-sided middle (alpha tested, no vertical repeat)
      if (sd.middle !== '-') {
        const t = wallReg.use(sd.middle);
        if (t >= 0) {
          const th = wallReg.size(t).h, dpb = (ld.flags & ML_DONTPEGBOTTOM) !== 0;
          const lo = Math.max(A.floor, Bs.floor), hi = Math.min(A.ceil, Bs.ceil);
          const loB = A.floor >= Bs.floor ? fl(sec) : fl(osec), hiB = A.ceil <= Bs.ceil ? ce(sec) : ce(osec);
          const topZ = (dpb ? lo + th : hi) + sd.yoff, anchor = dpb ? loB : hiB;
          const zb = Math.max(lo, topZ - th), zt = Math.min(hi, topZ);
          quad(B.masked, unit, sec, x1, y1, x2, y2, zb, zt, u0, topZ, t, adjBase, zb === lo ? loB : anchor, zt === hi ? hiB : anchor, anchor, dl);
        }
      }
    }
  });

  // floors and ceilings, one unit per BSP subsector
  const polys = subsectorPolygons(map);
  const ssSector = new Int32Array(nss).fill(-1), ssBox = new Float32Array(nss * 4);
  map.subsectors.forEach((ss, i) => {
    const poly = polys[i], unit = nl * 2 + i;
    const seg = map.segs[ss.first];
    if (!seg) return;
    const ld = linedefs[seg.linedef];
    const sdi = seg.side ? ld.back : ld.front;
    if (sdi < 0) return;
    const si = sidedefs[sdi].sector;
    ssSector[i] = si;
    // xy box of the subsector: polygon if any, else its segs
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const grow = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
    if (poly) for (const p of poly) grow(p[0], p[1]);
    for (let k = 0; k < ss.count; k++) { const sg = map.segs[ss.first + k]; const a = vertices[sg.v1], b = vertices[sg.v2]; if (a) grow(a.x, a.y); if (b) grow(b.x, b.y); }
    ssBox.set([x0, y0, x1, y1], i * 4);
    if (!poly) return;
    const S = sectors[si];
    const n = poly.length;
    const emit = (batch, z, tex, bind) => {
      const base = batch.u[unit] ? batch.u[unit].n : 0;
      for (let k = 0; k < n; k++) batch.vert(unit, poly[k][0], poly[k][1], z, poly[k][0], -poly[k][1], tex, si, 0, bind, -2, 0, 0);
      for (let k = 1; k < n - 1; k++) batch.tri(unit, base, base + k, base + k + 1);
      for (let k = 0; k < n; k++) touch(si, poly[k][0], poly[k][1], z, bind);
    };
    const ft = flatReg.use(S.floorTex);
    if (ft >= 0 && S.floorTex !== 'F_SKY1') emit(B.flat, S.floor, ft, fl(si));
    if (isSky(S)) emit(B.sky, S.ceil, 0, ce(si));
    else {
      const ct = flatReg.use(S.ceilTex);
      if (ct >= 0) emit(B.flat, S.ceil, ct, ce(si));
    }
  });

  const out = {};
  for (const k of Object.keys(B)) out[k] = B[k].finalize();
  // flatten z entries: for sector s entries [zStart[s], zStart[s+1]) of (bind, zmin, zmax)
  let ne = 0; for (const m of zent) ne += m.size;
  const zStart = new Int32Array(nsec + 1), zData = new Float32Array(ne * 3);
  let eo = 0;
  zent.forEach((m, s) => {
    zStart[s] = eo;
    for (const [bind, [lo, hi]] of m) { zData[eo * 3] = bind; zData[eo * 3 + 1] = lo; zData[eo * 3 + 2] = hi; eo++; }
  });
  zStart[nsec] = eo;
  for (let i = 0; i < nsec; i++) if (sbox[i * 4] > sbox[i * 4 + 2]) sbox.fill(0, i * 4, i * 4 + 4);
  return { batches: out, nUnits, nLines: nl, nSubsectors: nss, ssSector, ssBox, sbox, zStart, zData, dynamic: dyn };
}
