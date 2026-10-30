// Hand-made MapData fixtures following the shared MapData contract.
// rects: [{x0,y0,x1,y1,floor,ceil}] - adjacent rects must share complete edges (-> two-sided lines).
export function buildMap(rects, things = [], extraFlags = {}) {
  const vertices = [], vmap = new Map();
  const V = (x, y) => { const k = x + ',' + y; if (!vmap.has(k)) { vmap.set(k, vertices.length); vertices.push({ x, y }); } return vmap.get(k); };
  const sectors = rects.map(r => ({ floor: r.floor ?? 0, ceil: r.ceil ?? 256, floorTex: 'FLOOR', ceilTex: 'CEIL', light: 200, special: 0, tag: 0 }));
  const sidedefs = [], linedefs = [];
  const side = s => { sidedefs.push({ xoff: 0, yoff: 0, upper: '-', lower: '-', middle: '-', sector: s }); return sidedefs.length - 1; };
  const edges = new Map();
  // clockwise (y up): interior on the right side of travel
  rects.forEach((r, i) => {
    const e = [[r.x0, r.y0, r.x0, r.y1], [r.x0, r.y1, r.x1, r.y1], [r.x1, r.y1, r.x1, r.y0], [r.x1, r.y0, r.x0, r.y0]];
    for (const [a, b, c, d] of e) edges.set(`${a},${b},${c},${d}`, i);
  });
  rects.forEach((r, i) => {
    const e = [[r.x0, r.y0, r.x0, r.y1], [r.x0, r.y1, r.x1, r.y1], [r.x1, r.y1, r.x1, r.y0], [r.x1, r.y0, r.x0, r.y0]];
    for (const [a, b, c, d] of e) {
      const other = edges.get(`${c},${d},${a},${b}`);
      if (other !== undefined && other < i) continue;
      const flags = other !== undefined ? 4 : 1;
      linedefs.push({ v1: V(a, b), v2: V(c, d), flags: flags | (extraFlags.blockAll && other !== undefined ? 1 : 0), special: 0, tag: 0,
        front: side(i), back: other !== undefined ? side(other) : -1 });
    }
  });
  return { vertices, linedefs, sidedefs, sectors, things, segs: [], subsectors: [], nodes: [] };
}
const dm = (x, y, angle = 0) => ({ x, y, angle, type: 11, flags: 7 });
export const arena = () => buildMap([{ x0: 0, y0: 0, x1: 1024, y1: 1024 }],
  [dm(128, 128), dm(900, 900, 180), dm(128, 900, 270), dm(900, 128, 90)]);
// A (floor 0) | B (floor h): player starts in A at (150,100)
export const stepMap = h => buildMap([
  { x0: 0, y0: 0, x1: 300, y1: 200, floor: 0, ceil: 256 },
  { x0: 300, y0: 0, x1: 600, y1: 200, floor: h, ceil: 256 },
], [dm(150, 100), dm(450, 100)]);
// corridor 64 wide between two rooms with a low ceiling doorway between
export const corridor = () => buildMap([
  { x0: 0, y0: 0, x1: 256, y1: 96 }, { x0: 0, y0: 96, x1: 256, y1: 160 }, { x0: 0, y0: 160, x1: 256, y1: 256 },
  { x0: 256, y0: 96, x1: 640, y1: 160 },
  { x0: 640, y0: 0, x1: 896, y1: 96 }, { x0: 640, y0: 96, x1: 896, y1: 160 }, { x0: 640, y0: 160, x1: 896, y1: 256 },
], [dm(64, 128), dm(800, 128)]);
// two-sided "window": rooms separated by a line flagged impassable (flag 1) but two-sided
export const windowMap = () => buildMap([
  { x0: 0, y0: 0, x1: 300, y1: 200 }, { x0: 300, y0: 0, x1: 600, y1: 200 }], [dm(100, 100), dm(500, 100)], { blockAll: true });
// low ceiling room next to a normal room (opening < 56)
export const lowCeil = () => buildMap([
  { x0: 0, y0: 0, x1: 300, y1: 200 }, { x0: 300, y0: 0, x1: 600, y1: 200, ceil: 40 }], [dm(100, 100), dm(500, 100)]);
// item room: arena plus things
export const itemArena = () => {
  const m = arena();
  m.things.push({ x: 300, y: 128, angle: 0, type: 2001, flags: 7 }, { x: 400, y: 128, angle: 0, type: 2012, flags: 7 },
    { x: 500, y: 128, angle: 0, type: 2019, flags: 7 }, { x: 600, y: 128, angle: 0, type: 2010, flags: 7 }, { x: 700, y: 128, angle: 0, type: 2007, flags: 7 });
  return m;
};
export const isIn = (p, x0, y0, x1, y1, r = 16) => p.x >= x0 + r - 0.01 && p.x <= x1 - r + 0.01 && p.y >= y0 + r - 0.01 && p.y <= y1 - r + 0.01;
