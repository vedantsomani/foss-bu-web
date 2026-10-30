// viewmodel.js - first-person weapon presentation (sway, bob, landing dip, recoil, muzzle events, lower/raise).
// DESIGN CHOICE: the weapon art is FreeDM's own Doom-format weapon sprites (PISGA0, SHTGA0, SHT2A0, CHGGA0, MISGA0,
// PLSGA0, BFGGA0 + flash sprites *F*) read from the WAD (see sprites.js), drawn onto a 2D canvas overlay with
// nearest-neighbour scaling in Doom's 320x200 virtual space (pixel-exact original offsets). If sprites are absent
// a procedural gun + hands is drawn instead (drawProceduralHands). Everything that animates is a pure function of
// (state, dt, ctx) so it can be unit tested without a DOM.
import { WEAPONS, SPRITE_FRAMES } from './weapons.js';

export const VW = 320, VH = 200;       // virtual Doom screen
const SWITCH_TICKS = 10, SWITCH_DROP = 110;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = t => t * t * (3 - 2 * t);

// Semi-implicit damped spring. Returns [pos, vel].
export function spring(pos, vel, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
  for (let i = 0; i < n; i++) { vel += ((target - pos) * k - vel * c) * h; pos += vel * h; }
  return [pos, vel];
}
// walk bob: figure-eight, Y at double frequency. amp in px.
export function bobOffset(phase, amp) { return { x: Math.sin(phase) * 5.5 * amp, y: (1 - Math.cos(phase * 2)) * 0.5 * 4.0 * amp }; }
// Doom fire sequences as [gunFrameIndex, tics@35Hz]; scaled to fit the weapon's cooldown.
const SEQ = {
  0: [[1, 6], [2, 4], [3, 5], [2, 4], [1, 5]],
  1: [[0, 10], [1, 5], [2, 5], [3, 4], [2, 5], [1, 5], [0, 3]],
  2: [[0, 10], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 6], [7, 6], [0, 5]],
  3: [[0, 4]],            // frame alternates per shot (see below)
  4: [[1, 8], [1, 12], [0, 10]],
  5: [[0, 3], [1, 20]],
  6: [[1, 10], [2, 10], [1, 10], [0, 8]],
};
export function fireFrame(weapon, shots, t, cooldownSec) {
  const seq = SEQ[weapon] || [[0, 1]];
  if (weapon === 3) return t < cooldownSec ? shots % 2 : 0;
  const total = seq.reduce((a, s) => a + s[1], 0), scale = Math.min(cooldownSec, total / 35) / total;
  let acc = 0;
  for (const [f, tics] of seq) { acc += tics * scale; if (t < acc) return f; }
  return 0;
}

export function createViewModel() {
  return { t: 0, phase: 0, bobAmp: 0, swayX: 0, swayVX: 0, swayY: 0, swayVY: 0, land: 0, landV: 0,
    kick: 0, kickV: 0, kickRot: 0, kickRotV: 0, camKick: 0, camKickV: 0, fireT: 99, flashT: 99, shots: 0, weapon: 0,
    drop: 0, out: [], lastYaw: null, lastPitch: null, side: 1 };
}

// ctx: { speed, grounded, sprint, lookDX, lookDY (radians moved this frame; sign = yaw/pitch delta), weapon, wstate, wtimer,
//        events:[{t:'fire'|'land'|'jump'|'switch', v?}], player:{x,y,z,yaw,pitch} , stepOff }
export function updateViewModel(vm, dt, ctx) {
  vm.t += dt;
  vm.weapon = ctx.weapon ?? vm.weapon;
  const w = WEAPONS[vm.weapon];
  // ----- events
  for (const e of ctx.events || []) {
    if (e.t === 'fire') {
      vm.fireT = 0; vm.flashT = 0; vm.shots++;
      vm.kickV += 180 * w.recoil; vm.kickRotV += (vm.side *= -1) * 0.5 * w.recoil; vm.camKickV += 0.35 * w.recoil;
      if (ctx.player) vm.out.push({ type: 'muzzle', ...muzzleWorldPos(ctx.player), w: vm.weapon, flashSec: w.flashTicks / 60 });
    } else if (e.t === 'land') vm.landV += clamp((e.v || 400) * 0.15, 12, 140);
    else if (e.t === 'jump') vm.landV -= 18;
    else if (e.t === 'switch') vm.out.push({ type: 'switch', w: e.w });
  }
  // ----- walk bob (stride-locked phase, amplitude eases in/out)
  const moving = ctx.grounded && ctx.speed > 20;
  const targetAmp = moving ? clamp(ctx.speed / 420, 0, 1.4) * (ctx.sprint ? 1.25 : 1) : 0;
  vm.bobAmp += (targetAmp - vm.bobAmp) * Math.min(1, dt * 10);
  if (moving) vm.phase += dt * ctx.speed * 0.017;
  // ----- mouse sway: spring toward the (negated, clamped) look velocity
  const lx = ctx.lookDX || 0, ly = ctx.lookDY || 0;
  const tx = clamp(-lx / Math.max(dt, 1e-4) * 6, -16, 16), ty = clamp(ly / Math.max(dt, 1e-4) * 4, -9, 9);
  [vm.swayX, vm.swayVX] = spring(vm.swayX, vm.swayVX, tx, 90, 14, dt);
  [vm.swayY, vm.swayVY] = spring(vm.swayY, vm.swayVY, ty, 90, 14, dt);
  // ----- landing dip, recoil (all spring back to 0)
  [vm.land, vm.landV] = spring(vm.land, vm.landV, 0, 140, 11, dt);
  [vm.kick, vm.kickV] = spring(vm.kick, vm.kickV, 0, 220, 20, dt);
  [vm.kickRot, vm.kickRotV] = spring(vm.kickRot, vm.kickRotV, 0, 160, 14, dt);
  [vm.camKick, vm.camKickV] = spring(vm.camKick, vm.camKickV, 0, 90, 12, dt);
  vm.fireT += dt; vm.flashT += dt;
  // ----- lower / raise
  if (ctx.wstate === 1) vm.drop = 1 - clamp((ctx.wtimer ?? 0) / SWITCH_TICKS, 0, 1);
  else if (ctx.wstate === 2) vm.drop = clamp((ctx.wtimer ?? 0) / SWITCH_TICKS, 0, 1);
  else vm.drop = 0;
  return computePose(vm, ctx.stepOff || 0);
}

export function computePose(vm, stepOff = 0) {
  const w = WEAPONS[vm.weapon], b = bobOffset(vm.phase, vm.bobAmp);
  const cooldownSec = w.cooldown / 60;
  const frames = SPRITE_FRAMES[vm.weapon];
  const gi = vm.fireT < cooldownSec ? fireFrame(vm.weapon, vm.shots, vm.fireT, cooldownSec) : 0;
  const flashing = vm.flashT < w.flashTicks / 60;
  let fi = 0;
  if (flashing) {
    const n = frames.flash.length, p = vm.flashT / (w.flashTicks / 60);
    fi = vm.weapon === 3 ? vm.shots % n : Math.min(n - 1, Math.floor(p * n));
  }
  return {
    x: b.x + vm.swayX, y: b.y + vm.swayY + vm.land + vm.kick - stepOff * 0.15 + smooth(vm.drop) * SWITCH_DROP,
    rot: vm.kickRot * 0.02, scale: 1 + vm.kick * 0.0015,
    gunLump: frames.gun[Math.min(gi, frames.gun.length - 1)], flashLump: flashing ? frames.flash[fi] : null,
    flashAlpha: flashing ? 1 - clamp(vm.flashT / (w.flashTicks / 60), 0, 1) * 0.5 : 0,
    camPitch: vm.camKick * 0.012, drop: vm.drop, weapon: vm.weapon,
  };
}
export function drainViewEvents(vm) { const o = vm.out; vm.out = []; return o; }

// world position of the muzzle: eye + forward*24 + right*7 - up*5   (Doom units; renderer spawns a dynamic light here)
export function muzzleWorldPos(p, eye = 48) {
  const cp = Math.cos(p.pitch), fx = Math.cos(p.yaw) * cp, fy = Math.sin(p.yaw) * cp, fz = Math.sin(p.pitch);
  const rx = Math.sin(p.yaw), ry = -Math.cos(p.yaw);
  return { x: p.x + fx * 24 + rx * 7, y: p.y + fy * 24 + ry * 7, z: p.z + (p.eyeZ !== undefined ? p.eyeZ - p.z : eye) + fz * 24 - 5 };
}

// ------------------------------------------------------------------ drawing (DOM canvas 2D)
// sprites: { LUMPNAME: {canvas|bitmap, width, height, left, top} }. w,h: canvas size in device pixels.
export function drawViewModel(g, pose, sprites, w, h, opts = {}) {
  const s = h / VH, ox = w / 2 - (VW / 2) * s;
  g.save();
  g.imageSmoothingEnabled = false;
  const gun = sprites && sprites[pose.gunLump];
  if (!gun) { drawProceduralHands(g, pose, w, h); g.restore(); return; }
  const place = spr => {
    const x = (1 - spr.left) + pose.x, y = 31.5 - spr.top + pose.y + (opts.baseline || 0);
    g.save();
    g.translate(ox + (x + spr.width / 2) * s, (y + spr.height) * s); // pivot at bottom centre of the sprite
    g.rotate(pose.rot); g.scale(pose.scale, pose.scale);
    g.translate(-(spr.width / 2) * s, -spr.height * s);
    return spr;
  };
  const sp = place(gun);
  g.drawImage(gun.canvas || gun.bitmap, 0, 0, sp.width * s, sp.height * s);
  g.restore();
  if (pose.flashLump && sprites[pose.flashLump] && pose.drop < 0.05) {
    const f = sprites[pose.flashLump];
    g.save(); g.globalAlpha = pose.flashAlpha; g.globalCompositeOperation = 'lighter';
    const fs = place(f); g.drawImage(f.canvas || f.bitmap, 0, 0, fs.width * s, fs.height * s);
    g.restore(); g.restore();
  }
  g.restore();
}
export function drawProceduralHands(g, pose, w, h) {
  const s = h / VH, cx = w / 2 + pose.x * s, by = h + 20 * s + pose.y * s;
  g.save(); g.translate(cx, by); g.rotate(pose.rot); g.scale(pose.scale, pose.scale);
  const px = (x, y, ww, hh, c) => { g.fillStyle = c; g.fillRect(Math.round(x * s), Math.round(y * s), Math.round(ww * s), Math.round(hh * s)); };
  px(-14, -78, 28, 56, '#44474c'); px(-10, -86, 20, 12, '#5a5e65'); px(-5, -90, 10, 6, '#2b2d31');   // barrel / slide
  px(-34, -34, 24, 40, '#c08a64'); px(10, -34, 24, 40, '#c08a64');                                  // hands
  px(-34, -34, 24, 8, '#a87450'); px(10, -34, 24, 8, '#a87450');
  if (pose.flashLump) { g.globalAlpha = pose.flashAlpha; px(-9, -108, 18, 20, '#ffd060'); px(-4, -116, 8, 10, '#fff4c0'); }
  g.restore();
}
