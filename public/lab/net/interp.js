// interp.js - snapshot interpolation buffer for remote entities.
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}
export class Interpolator {
  constructor(maxSnaps = 40) { this.buf = []; this.max = maxSnaps; }
  push(tick, players) {
    const b = this.buf;
    if (b.length && tick <= b[b.length - 1].tick) { // out of order / duplicate
      const i = b.findIndex(s => s.tick === tick); if (i >= 0) return; // ignore dup
      b.push({ tick, players }); b.sort((x, y) => x.tick - y.tick);
    } else b.push({ tick, players });
    while (b.length > this.max) b.shift();
  }
  get newestTick() { return this.buf.length ? this.buf[this.buf.length - 1].tick : 0; }
  // returns {id: {x,y,z,yaw,pitch, ...fields of the earlier snapshot}} at fractional server tick rt
  sample(rt, maxExtrapolate = 4) {
    const b = this.buf, out = {};
    if (!b.length) return out;
    let i = b.length - 1;
    while (i > 0 && b[i].tick > rt) i--;
    const A = b[i], B = b[i + 1] || null;
    const ids = new Set(Object.keys(A.players)); if (B) for (const k of Object.keys(B.players)) ids.add(k);
    for (const k of ids) {
      const a = A.players[k], bb = B && B.players[k];
      if (!a && !bb) continue;
      if (a && bb && rt >= A.tick) {
        const span = B.tick - A.tick;
        let t = span > 0 ? (rt - A.tick) / span : 1; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const teleport = a.alive !== bb.alive || Math.hypot(bb.x - a.x, bb.y - a.y) > 300;
        if (teleport) t = 0;
        out[k] = { ...a, x: lerp(a.x, bb.x, t), y: lerp(a.y, bb.y, t), z: lerp(a.z, bb.z, t), yaw: lerpAngle(a.yaw, bb.yaw, t), pitch: lerp(a.pitch, bb.pitch, t), _t: t };
      } else if (a) {
        // ahead of newest data (or before oldest): hold, with short velocity extrapolation after the newest
        const ahead = Math.max(0, Math.min(maxExtrapolate, rt - A.tick)) / 60;
        const ex = (i === b.length - 1 && a.alive) ? ahead : 0;
        out[k] = { ...a, x: a.x + a.vx * ex, y: a.y + a.vy * ex, _t: 0, _extrap: ex > 0 };
      } else out[k] = { ...bb, _t: 1 };
    }
    return out;
  }
}
