// input.js - keyboard / mouse / pointer-lock. Mouse deltas are applied to the live view angles immediately (render uses
// them every frame); the 60 Hz command only samples them. sample() fills a reused object (no per-tick allocation).
import { BTN } from '../game/sim.js';

const USE = BTN.USE === undefined ? 8 : BTN.USE;
const PITCH_LIMIT = 1.45, TAU = Math.PI * 2;

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas; this.s = settings;
    this.yaw = 0; this.pitch = 0; this.down = Object.create(null);
    this.fireDown = false; this.fireLatch = false; this.jumpLatch = false; this.useLatch = false;
    this.wantWeapon = 0; this.wantTicks = 0; this.wheel = 0;
    this.locked = false; this.enabled = false; this.forceActive = false;   // forceActive: tests / no pointer lock available
    this.onUnlock = null; this.onEscape = null; this.onScoreboard = null; this.kbLock = false;
    this.cycle = null;   // (dir) => weapon number to switch to, set by main
    const el = document;
    el.addEventListener('mousemove', e => {
      if (!this.active) return;
      const k = 0.022 * this.s.sens * Math.PI / 180;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.s.invertY ? -1 : 1);
      if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT; else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
      if (this.yaw > TAU) this.yaw -= TAU; else if (this.yaw < 0) this.yaw += TAU;
    });
    el.addEventListener('mousedown', e => { if (!this.active) return; if (e.button === 0) { this.fireDown = true; this.fireLatch = true; } e.preventDefault(); });
    el.addEventListener('mouseup', e => { if (e.button === 0) this.fireDown = false; });
    el.addEventListener('wheel', e => { if (this.active && this.cycle) { this.wheel += Math.sign(e.deltaY); } }, { passive: true });
    el.addEventListener('contextmenu', e => { if (this.active) e.preventDefault(); });
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (e.code === 'Escape') { if (this.enabled && this.onEscape) this.onEscape(); return; }
      if (!this.enabled) return;
      if (e.code === 'Tab') { e.preventDefault(); if (this.onScoreboard) this.onScoreboard(true); }
      if (e.repeat) { if (this.active && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault(); return; }
      if (!this.active) return;
      this.down[e.code] = true;
      if (e.code === 'Space') { this.jumpLatch = true; e.preventDefault(); }
      else if (e.code === 'KeyE') this.useLatch = true;
      else if (e.code.startsWith('Digit')) { const n = +e.code.slice(5); if (n >= 1 && n <= 7) { this.wantWeapon = n; this.wantTicks = 24; } }
    });
    addEventListener('keyup', e => { this.down[e.code] = false; if (e.code === 'Tab' && this.onScoreboard) { e.preventDefault(); this.onScoreboard(false); } });
    addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked; this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.releaseAll(); if (was && this.onUnlock) this.onUnlock(); }
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });
  }
  get active() { return this.enabled && (this.locked || this.forceActive); }
  releaseAll() { for (const k in this.down) this.down[k] = false; this.fireDown = false; }
  // call inside a user gesture. Pointer lock first: requestFullscreen consumes the transient activation that pointer lock needs.
  lock(fullscreen = true) {
    const de = document.documentElement, c = this.canvas;
    // unadjustedMovement (raw mouse) is not available everywhere (e.g. Chrome on Linux). A rejected request burns the user
    // activation, so remember the failure: the fallback then runs on the next click (the overlay is shown), not silently.
    const plain = () => { try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } };
    if (this.noUnadj === undefined) this.noUnadj = /Linux/i.test(navigator.platform || '') && !/Android/i.test(navigator.userAgent || '');
    if (this.noUnadj) plain();
    else {
      try {
        const r = c.requestPointerLock({ unadjustedMovement: true });
        if (r && r.catch) r.catch(e => { if (e && e.name === 'NotSupportedError') this.noUnadj = true; });
      } catch { this.noUnadj = true; plain(); }
    }
    const kb = () => { if (navigator.keyboard && navigator.keyboard.lock && !this.kbLock) navigator.keyboard.lock(['Escape']).then(() => { this.kbLock = true; }, () => {}); };
    if (fullscreen && !document.fullscreenElement && de.requestFullscreen) de.requestFullscreen({ navigationUI: 'hide' }).then(kb, () => {});
    else if (document.fullscreenElement) kb();
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  // fills out; me = predicted local player (for weapon cycling / sticky weapon requests)
  sample(out, me) {
    const k = this.down;
    out.fwd = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0);
    out.side = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    out.yaw = this.yaw; out.pitch = this.pitch;
    let b = 0;
    if (this.fireDown || this.fireLatch) b |= BTN.FIRE;
    if (k.Space || this.jumpLatch) b |= BTN.JUMP;
    if (k.ShiftLeft || k.ShiftRight) b |= BTN.SPRINT;
    if (this.useLatch) b |= USE;
    this.fireLatch = this.jumpLatch = this.useLatch = false;
    out.buttons = b;
    if (this.wheel && me && this.cycle) { const w = this.cycle(Math.sign(this.wheel), me); if (w) { this.wantWeapon = w; this.wantTicks = 24; } this.wheel = 0; }
    // weapon requests are sticky for a few ticks (the sim ignores them while a switch is in progress)
    out.weapon = 0;
    if (this.wantWeapon) {
      if (me && (me.weapon === this.wantWeapon - 1 || (me.wstate !== 0 && me.pendW === this.wantWeapon - 1)) || --this.wantTicks <= 0) this.wantWeapon = 0;
      else out.weapon = this.wantWeapon;
    }
    return out;
  }
  neutral(out) { out.fwd = out.side = out.buttons = out.weapon = 0; out.yaw = this.yaw; out.pitch = this.pitch; return out; }
}
