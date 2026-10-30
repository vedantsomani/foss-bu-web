// geometry.js - builds static per-sector mesh data for a Doom map.
//
// Vertex layout (8 floats): x, y, z (Doom units, z up), u, v (texel units), texId (logical id), sector, lightAdj
// Four batches (= four draw calls): wall (opaque/alpha-tested), masked (two-sided mid textures), flat, sky.
// Every batch keeps its indices grouped per sector so the renderer can frustum-cull per sector and still issue
// a single draw call per batch.

export const FLOATS_PER_VERTEX = 8;

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
  constructor(nsec) {
    this.sec = Array.from({ length: nsec }, () => ({ v: [], n: 0 }));
    this.tris = 0;
  }
  vert(s, x, y, z, u, v, tex, adj) {
    const b = this.sec[s];
    b.v.push(x, y, z, u, v, tex, s, adj);
    return b.n++;
  }
  tri(s, a, b, c) { (this.sec[s].i || (this.sec[s].i = [])).push(a, b, c); this.tris++; }
  finalize() {
    let nv = 0, ni = 0;
    for (const b of this.sec) { nv += b.n; ni += b.i ? b.i.length : 0; }
    const vertices = new Float32Array(nv * FLOATS_PER_VERTEX);
    const indices = new Uint32Array(ni);
    const ranges = new Int32Array(this.sec.length * 2);
    let vo = 0, io = 0, vbase = 0;
    this.sec.forEach((b, si) => {
      vertices.set(b.v, vo * FLOATS_PER_VERTEX);
      ranges[si * 2] = io;
      if (b.i) for (let k = 0; k < b.i.length; k++) indices[io++] = b.i[k] + vbase;
      ranges[si * 2 + 1] = io - ranges[si * 2];
      vo += b.n; vbase += b.n;
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

export function buildGeometry(map, wallReg, flatReg) {
  const nsec = map.sectors.length;
  const { vertices, linedefs, sidedefs, sectors } = map;
  const B = { wall: new Batch(nsec), masked: new Batch(nsec), flat: new Batch(nsec), sky: new Batch(nsec) };
  const bbox = new Float32Array(nsec * 6);
  for (let i = 0; i < nsec; i++) { bbox[i * 6] = bbox[i * 6 + 1] = bbox[i * 6 + 2] = 1e9; bbox[i * 6 + 3] = bbox[i * 6 + 4] = bbox[i * 6 + 5] = -1e9; }
  const touch = (s, x, y, z) => {
    const o = s * 6;
    if (x < bbox[o]) bbox[o] = x; if (y < bbox[o + 1]) bbox[o + 1] = y; if (z < bbox[o + 2]) bbox[o + 2] = z;
    if (x > bbox[o + 3]) bbox[o + 3] = x; if (y > bbox[o + 4]) bbox[o + 4] = y; if (z > bbox[o + 5]) bbox[o + 5] = z;
  };
  const isSky = (s) => s.ceilTex === 'F_SKY1';

  // quad between (x1,y1)->(x2,y2) from zb to zt. topZ = world z at texture row 0 (v = topZ - z).
  const quad = (batch, sec, x1, y1, x2, y2, zb, zt, u0, topZ, tex, adj) => {
    if (!(zt > zb)) return;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const u1 = u0 + len;
    const vt = topZ - zt, vb = topZ - zb;
    const a = batch.vert(sec, x1, y1, zb, u0, vb, tex, adj);
    const b = batch.vert(sec, x2, y2, zb, u1, vb, tex, adj);
    const c = batch.vert(sec, x2, y2, zt, u1, vt, tex, adj);
    const d = batch.vert(sec, x1, y1, zt, u0, vt, tex, adj);
    batch.tri(sec, a, b, c); batch.tri(sec, a, c, d);
    touch(sec, x1, y1, zb); touch(sec, x2, y2, zt);
  };

  for (const ld of linedefs) {
    const va = vertices[ld.v1], vb = vertices[ld.v2];
    if (!va || !vb) continue;
    const adjBase = va.y === vb.y ? -16 : va.x === vb.x ? 16 : 0;
    for (let side = 0; side < 2; side++) {
      const sdi = side === 0 ? ld.front : ld.back;
      if (sdi < 0) continue;
      const osd = side === 0 ? ld.back : ld.front;
      const sd = sidedefs[sdi];
      const A = sectors[sd.sector];
      const [x1, y1, x2, y2] = side === 0 ? [va.x, va.y, vb.x, vb.y] : [vb.x, vb.y, va.x, va.y];
      const u0 = sd.xoff;
      if (osd < 0) {
        // one-sided: middle only
        const t = wallReg.use(sd.middle);
        if (t < 0) continue;
        const th = wallReg.size(t).h;
        const topZ = ((ld.flags & ML_DONTPEGBOTTOM) ? A.floor + th : A.ceil) + sd.yoff;
        quad(B.wall, sd.sector, x1, y1, x2, y2, A.floor, A.ceil, u0, topZ, t, adjBase);
        continue;
      }
      const Bs = sectors[sidedefs[osd].sector];
      // lower
      if (Bs.floor > A.floor) {
        const t = wallReg.use(sd.lower);
        if (t >= 0) {
          const topZ = ((ld.flags & ML_DONTPEGBOTTOM) ? A.ceil : Bs.floor) + sd.yoff;
          quad(B.wall, sd.sector, x1, y1, x2, y2, A.floor, Bs.floor, u0, topZ, t, adjBase);
        }
      }
      // upper
      if (Bs.ceil < A.ceil) {
        if (isSky(A) && isSky(Bs)) {
          quad(B.sky, sd.sector, x1, y1, x2, y2, Bs.ceil, A.ceil, 0, A.ceil, 0, 0);
        } else {
          const t = wallReg.use(sd.upper);
          if (t >= 0) {
            const th = wallReg.size(t).h;
            const topZ = ((ld.flags & ML_DONTPEGTOP) ? A.ceil : Bs.ceil + th) + sd.yoff;
            quad(B.wall, sd.sector, x1, y1, x2, y2, Bs.ceil, A.ceil, u0, topZ, t, adjBase);
          }
        }
      }
      // two-sided middle (alpha tested, no vertical repeat)
      if (sd.middle !== '-') {
        const t = wallReg.use(sd.middle);
        if (t >= 0) {
          const th = wallReg.size(t).h;
          const lo = Math.max(A.floor, Bs.floor), hi = Math.min(A.ceil, Bs.ceil);
          const topZ = ((ld.flags & ML_DONTPEGBOTTOM) ? lo + th : hi) + sd.yoff;
          quad(B.masked, sd.sector, x1, y1, x2, y2, Math.max(lo, topZ - th), Math.min(hi, topZ), u0, topZ, t, adjBase);
        }
      }
    }
  }

  // floors and ceilings
  const polys = subsectorPolygons(map);
  map.subsectors.forEach((ss, i) => {
    const poly = polys[i];
    if (!poly) return;
    const seg = map.segs[ss.first];
    if (!seg) return;
    const ld = linedefs[seg.linedef];
    const sdi = seg.side ? ld.back : ld.front;
    if (sdi < 0) return;
    const si = sidedefs[sdi].sector;
    const S = sectors[si];
    const n = poly.length;
    const emit = (batch, z, tex) => {
      const base = batch.sec[si].n;
      for (let k = 0; k < n; k++) batch.vert(si, poly[k][0], poly[k][1], z, poly[k][0], -poly[k][1], tex, 0);
      for (let k = 1; k < n - 1; k++) batch.tri(si, base, base + k, base + k + 1);
      for (let k = 0; k < n; k++) touch(si, poly[k][0], poly[k][1], z);
    };
    const ft = flatReg.use(S.floorTex);
    if (ft >= 0 && S.floorTex !== 'F_SKY1') emit(B.flat, S.floor, ft);
    if (isSky(S)) emit(B.sky, S.ceil, 0);
    else {
      const ct = flatReg.use(S.ceilTex);
      if (ct >= 0) emit(B.flat, S.ceil, ct);
    }
  });

  const out = {};
  for (const k of Object.keys(B)) out[k] = B[k].finalize();
  for (let i = 0; i < nsec; i++) if (bbox[i * 6] > bbox[i * 6 + 3]) bbox.fill(0, i * 6, i * 6 + 6);
  return { batches: out, bbox };
}
