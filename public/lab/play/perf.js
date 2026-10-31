// perf.js - dynamic resolution. Measures the interval between *rendered* frames; when it exceeds the target (display
// refresh or FPS cap) the renderer's internal scale steps down, and steps back up when there is sustained headroom.
export const LEVELS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const HZ = [60, 75, 90, 120, 144, 165, 240];

export class DynRes {
  constructor(onLevel) {
    this.onLevel = onLevel; this.i = LEVELS.length - 1; this.enabled = true;
    this.buf = new Float32Array(30); this.n = 0; this.warm = []; this.refreshMs = 1000 / 60;
    this.lastChange = 0; this.lastDown = -1e9; this.lastUp = -1e9; this.hold = 4000; this.warmed = false;
  }
  get scale() { return LEVELS[this.i]; }
  reset() { this.i = LEVELS.length - 1; this.n = 0; this.lastDown = -1e9; this.hold = 4000; }
  // dt: ms between rendered frames, now: ms, cap: fps cap or 0, headroomMs: max(cpu,gpu) frame cost if known else 0
  frame(dt, now, cap, headroomMs) {
    if (!this.warmed) {   // nominal refresh = snapped median of the first frames (falls back to 60 Hz when load-bound)
      if (!this.warm.length) this.warmStart = now;
      this.warm.push(dt);
      if (this.warm.length >= 90 || (this.warm.length >= 8 && now - this.warmStart > 2500)) {
        const s = this.warm.slice(Math.min(10, this.warm.length >> 2)).sort((a, b) => a - b), med = s[s.length >> 1], hz = 1000 / med;
        const best = HZ.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
        this.refreshMs = Math.abs(best - hz) / best < 0.08 ? 1000 / best : 1000 / 60; this.warmed = true;
      }
      return;
    }
    if (!this.enabled) return;
    if (this.n === 0) this.winStart = now;
    this.buf[this.n++] = dt;
    // evaluate every 30 frames, or sooner (>= 6 frames) once 600 ms passed - slow machines must not wait for 30 slow frames
    if (this.n < this.buf.length && !(this.n >= 6 && now - this.winStart > 600)) return;
    const s = Array.from(this.buf.subarray(0, this.n)).sort((a, b) => a - b), k = Math.max(1, Math.floor(s.length * 0.9));
    this.n = 0;
    let avg = 0; for (let i = 0; i < k; i++) avg += s[i]; avg /= k;
    const target = cap ? 1000 / cap : this.refreshMs;
    if (now - this.lastChange < 1000) return;
    if (avg > target * 1.15 && this.i > 0) {
      this.i -= avg > target * 1.7 && this.i > 1 ? 2 : 1;
      if (now - this.lastUp < 3000) this.hold = Math.min(60000, this.hold * 2);   // we just went up and it did not hold
      this.lastDown = this.lastChange = now; this.onLevel(this.scale);
    } else if (avg < target * 1.06 && this.i < LEVELS.length - 1 && now - this.lastDown > this.hold && (!headroomMs || headroomMs < target * 0.8)) {
      this.i++; this.lastUp = this.lastChange = now; this.onLevel(this.scale);
    }
  }
}
