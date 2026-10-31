// input.js - keyboard / mouse / pointer-lock. Mouse deltas are applied to the live view angles immediately (render uses
// them every frame); the 60 Hz command only samples them. sample() fills a reused object (no per-tick allocation).
import { BTN } from '../game/sim.js';

const USE = BTN.USE === undefined ? 8 : BTN.USE;
const PITCH_LIMIT = 1.45, TAU = Math.PI * 2;
// Controller (standard-mapping gamepad). Buttons: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Start,
// 10 L3, 11 R3, 12-15 D-pad up/down/left/right.
const PAD_DEAD = 0.16, PAD_LOOK_DEG = 260;   // look speed in degrees/second at full deflection
const _stick = [0, 0];
// Radial deadzone rescaled to 0..1, then a power curve so small deflections give fine aim.
function stick(x, y, curve) {
  const m = Math.hypot(x, y);
  if (m < PAD_DEAD) { _stick[0] = _stick[1] = 0; return _stick; }
  const k = Math.pow(Math.min(1, (m - PAD_DEAD) / (1 - PAD_DEAD)), curve) / m;
  _stick[0] = x * k; _stick[1] = y * k; return _stick;
}

export const ACTIONS = [
  ['fwd', 'Move forward'], ['back', 'Move backward'], ['left', 'Strafe left'], ['right', 'Strafe right'], ['fire', 'Fire'], ['use', 'Use / open'],
  ['jump', 'Jump (modern rules)'], ['run', 'Run'], ['next', 'Next weapon'], ['prev', 'Previous weapon'], ['scores', 'Scoreboard'],
  ['w1', 'Weapon 1'], ['w2', 'Weapon 2'], ['w3', 'Weapon 3'], ['w4', 'Weapon 4'], ['w5', 'Weapon 5'], ['w6', 'Weapon 6'], ['w7', 'Weapon 7'],
];
export const DEFAULT_KEYS = {
  fwd: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], fire: ['Mouse0', 'ControlLeft'], use: ['KeyE', 'Mouse2'],
  jump: ['Space', ''], run: ['ShiftLeft', 'ShiftRight'], next: ['WheelDown', ''], prev: ['WheelUp', ''], scores: ['Tab', ''],
  w1: ['Digit1', ''], w2: ['Digit2', ''], w3: ['Digit3', ''], w4: ['Digit4', ''], w5: ['Digit5', ''], w6: ['Digit6', ''], w7: ['Digit7', ''],
};
// human readable name of a key code ("KeyW" -> "W", "Mouse0" -> "Mouse 1")
export function codeName(c) {
  if (!c) return '---';
  if (c.startsWith('Mouse')) return 'MOUSE ' + (+c.slice(5) + 1);
  if (c === 'WheelUp') return 'WHEEL UP'; if (c === 'WheelDown') return 'WHEEL DOWN';
  return c.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', 'ARROW ').replace('Left', ' LEFT').replace('Right', ' RIGHT').replace('Control', 'CTRL').replace('Shift', 'SHIFT').trim().toUpperCase();
}

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas; this.s = settings;
    this.yaw = 0; this.pitch = 0; this.down = Object.create(null);
    this.fireDown = false; this.fireLatch = false; this.jumpLatch = false; this.useLatch = false;
    this.wantWeapon = 0; this.wantTicks = 0; this.wheel = 0;
    this.locked = false; this.enabled = false; this.forceActive = false;   // forceActive: tests / no pointer lock available
    this.onUnlock = null; this.onEscape = null; this.onScoreboard = null; this.kbLock = false;
    this.cycle = null;   // (dir) => weapon number to switch to, set by main
    this.pad = null; this.padPrev = 0; this.padActive = false; this.padFwd = 0; this.padSide = 0;
    this.padFire = false; this.padSprint = false; this.padScore = false;
    this.onPadMenu = null;   // (pressedBits, padStickY) while menus are up, set by main
    this.menu = false; this.lockAt = -1e9; this.capture = null;   // capture(code): next key / mouse button press is delivered here (key rebinding)
    this.map = null; this.mapSrc = null;
    const el = document;
    el.addEventListener('mousemove', e => {
      if (!this.active) return;
      // right after pointer lock engages the browser may report one big warp-to-centre delta: never turn the view with it
      if (performance.now() - this.lockAt < 150) return;
      const k = 0.022 * this.s.sens * Math.PI / 180;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k * (this.s.sensY || 1) * (this.s.invertY ? -1 : 1);
      if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT; else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
      if (this.yaw > TAU) this.yaw -= TAU; else if (this.yaw < 0) this.yaw += TAU;
    });
    el.addEventListener('mousedown', e => {
      if (this.capture) { e.preventDefault(); const f = this.capture; this.capture = null; f('Mouse' + e.button); return; }
      if (!this.active) return; this.press('Mouse' + e.button); e.preventDefault();
    });
    el.addEventListener('mouseup', e => { const c = 'Mouse' + e.button; this.down[c] = false; if (this.isCode('fire', c)) this.fireDown = this.act('fire'); });
    el.addEventListener('wheel', e => {
      if (this.capture) { const f = this.capture; this.capture = null; f(e.deltaY < 0 ? 'WheelUp' : 'WheelDown'); return; }
      if (!this.active) return;
      const c = e.deltaY < 0 ? 'WheelUp' : 'WheelDown', a = this.actionsOf(c);
      if (a.includes('next')) this.wheel += 1; else if (a.includes('prev')) this.wheel -= 1;
      else for (const x of a) if (/^w[1-7]$/.test(x)) { this.wantWeapon = +x[1]; this.wantTicks = 24; }
    }, { passive: true });
    el.addEventListener('contextmenu', e => { if (this.active) e.preventDefault(); });
    addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (this.capture) { e.preventDefault(); if (e.code === 'Escape') { this.capture = null; return; } const f = this.capture; this.capture = null; f(e.code); return; }
      if (e.code === 'Escape') { if (this.enabled && this.onEscape) this.onEscape(); return; }
      if (!this.enabled) return;
      if (this.actionsOf(e.code).includes('scores')) { e.preventDefault(); if (this.onScoreboard) this.onScoreboard(true); }
      if (e.repeat) { if (this.active && (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab')) e.preventDefault(); return; }
      if (!this.active) return;
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab' || e.code === 'ControlLeft') e.preventDefault();
      this.press(e.code);
    });
    addEventListener('keyup', e => {
      this.down[e.code] = false;
      if (this.isCode('fire', e.code)) this.fireDown = this.act('fire');
      if (this.isCode('scores', e.code) && this.onScoreboard) { e.preventDefault(); this.onScoreboard(false); }
    });
    addEventListener('blur', () => this.releaseAll());
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked; this.locked = document.pointerLockElement === canvas;
      if (this.locked && !was) this.lockAt = performance.now();
      if (!this.locked) { this.releaseAll(); if (was && this.onUnlock) this.onUnlock(); }
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });
  }
  // ---- key bindings (settings.keys: action -> [code, code])
  keys() { return this.s.keys || DEFAULT_KEYS; }
  actionsOf(code) {
    const k = this.keys(), out = [];
    if (!code) return out;
    for (const a in k) if (k[a] && k[a].includes(code)) out.push(a);
    return out;
  }
  isCode(action, code) { const k = this.keys()[action]; return !!k && k.includes(code); }
  act(action) { const k = this.keys()[action]; if (!k) return false; for (let i = 0; i < k.length; i++) if (k[i] && this.down[k[i]]) return true; return false; }
  press(code) {
    this.down[code] = true;
    for (const a of this.actionsOf(code)) {
      if (a === 'fire') { this.fireDown = true; this.fireLatch = true; }
      else if (a === 'jump') this.jumpLatch = true;
      else if (a === 'use') this.useLatch = true;
      else if (a === 'next') this.wheel += 1;
      else if (a === 'prev') this.wheel -= 1;
      else if (/^w[1-7]$/.test(a)) { this.wantWeapon = +a[1]; this.wantTicks = 24; }
    }
  }
  // A controller player may never get pointer lock (gamepad presses are not a user gesture), so pad use also counts.
  // `menu` is set by main while a menu / pause / end screen is up: input then drives the menus (pad) instead of the game.
  get active() { return this.enabled && !this.menu && (this.locked || this.forceActive || this.padActive); }
  // Poll the first standard gamepad; call once per display frame. Look is applied straight to the view angles.
  pollPad(dt) {
    let p = null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (pads) for (const g of pads) if (g && g.connected && g.mapping === 'standard') { p = g; break; }
    this.pad = p;
    if (!p) { this.padFwd = this.padSide = 0; this.padFire = this.padSprint = false; this.padPrev = 0; return; }
    let bits = 0;
    for (let i = 0; i < 16 && i < p.buttons.length; i++) if (p.buttons[i].pressed || p.buttons[i].value > 0.5) bits |= 1 << i;
    const pressed = bits & ~this.padPrev; this.padPrev = bits;
    const ax = p.axes;
    if (pressed || Math.abs(ax[0]) + Math.abs(ax[1]) + Math.abs(ax[2] || 0) + Math.abs(ax[3] || 0) > 0.6) this.padActive = true;
    if ((pressed & (1 << 9)) && this.enabled && this.onEscape) this.onEscape();          // Start: pause / resume
    if (!this.active) {
      this.padFwd = this.padSide = 0; this.padFire = this.padSprint = false;
      if (this.onPadMenu) this.onPadMenu(pressed, ax[1] || 0);
      return;
    }
    let v = stick(ax[0] || 0, ax[1] || 0, 1);
    this.padSide = v[0]; this.padFwd = -v[1];
    v = stick(ax[2] || 0, ax[3] || 0, 2);
    const rate = PAD_LOOK_DEG * (this.s.padSens || 1) * Math.PI / 180 * dt;
    this.yaw -= v[0] * rate;
    this.pitch -= v[1] * rate * 0.65 * (this.s.invertY ? -1 : 1);
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT; else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    if (this.yaw > TAU) this.yaw -= TAU; else if (this.yaw < 0) this.yaw += TAU;
    this.padFire = !!(bits & (1 << 7));
    this.padSprint = !!(bits & ((1 << 6) | (1 << 10)));
    if (pressed & (1 << 7)) this.fireLatch = true;
    if (pressed & 1) this.jumpLatch = true;
    if (pressed & ((1 << 2) | (1 << 3))) this.useLatch = true;
    if (pressed & ((1 << 5) | (1 << 15))) this.wheel += 1;
    if (pressed & ((1 << 4) | (1 << 14))) this.wheel -= 1;
    const score = !!(bits & (1 << 8));
    if (score !== this.padScore) { this.padScore = score; if (this.onScoreboard) this.onScoreboard(score); }
  }
  // Short rumble on controllers that support it (Chromium: vibrationActuator).
  rumble(strong, weak, ms) {
    const a = this.padActive && this.pad && this.pad.vibrationActuator;
    if (a && a.playEffect) a.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
  releaseAll() { for (const k in this.down) this.down[k] = false; this.fireDown = false; this.padFire = false; }
  // call inside a user gesture. Pointer lock first: requestFullscreen consumes the transient activation that pointer lock needs.
  lock(fullscreen = true) {
    const de = document.documentElement, c = this.canvas;
    this.lockAt = performance.now();
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
    const A = n => (this.act(n) ? 1 : 0);
    const fwd = A('fwd') - A('back') + this.padFwd;
    const side = A('right') - A('left') + this.padSide;
    out.fwd = fwd > 1 ? 1 : fwd < -1 ? -1 : fwd;
    out.side = side > 1 ? 1 : side < -1 ? -1 : side;
    out.yaw = this.yaw; out.pitch = this.pitch;
    let b = 0;
    if (this.fireDown || this.fireLatch || this.padFire) b |= BTN.FIRE;
    if (this.act('jump') || this.jumpLatch) b |= BTN.JUMP;
    if ((this.act('run') || this.padSprint) !== !!this.s.alwaysRun) b |= BTN.SPRINT;   // always run inverts the run key
    if (this.s.autoAim !== false) b |= BTN.AUTOAIM;
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
