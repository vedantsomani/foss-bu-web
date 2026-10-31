// rules.js - gameplay rulesets. "classic" reproduces vanilla Doom's feel (thrust + 0xE800 friction, walk/run/strafe-run speeds,
// no jumping, 1 unit/tic^2 gravity, 16+16 tic weapon lower/raise, Doom fire rates, bullet spread and refire inaccuracy, horizontal
// explosion thrust, 41-unit eye height). "modern" is the original Fragline tuning. The simulation still runs at 60 Hz; Doom's 35 Hz
// quantities are converted exactly (friction per second, speeds as the vanilla steady state, tics -> ticks by 60/35).
import { WEAPONS } from './weapons.js';

export const DOOM_TIC = 1 / 35;
const T = n => Math.round(n * 60 / 35);          // Doom tics -> 60 Hz ticks
export const DOOM_FRICTION = 0xE800 / 0x10000;     // per 35 Hz tic
const THRUST = 2048 / 65536;                       // map units / tic^2 per unit of cmd.forwardmove
// steady-state speed (units/second) for a cmd value: thrust / (1 - friction) per tic, times 35
export const doomSpeed = cmd => cmd * THRUST / (1 - DOOM_FRICTION) * 35;

export const RULESETS = {
  classic: {
    name: 'classic', move: 'doom', eye: 41, canJump: false, gravity: 1225, switchTicks: T(16), friction: DOOM_FRICTION,
    walkFwd: 25, runFwd: 50, walkSide: 24, runSide: 40, autoAll: true, horizontalKnock: true, bobMax: 16,
    wpn: {
      0: { cooldown: T(19), auto: true, spread: 0, dspread: { h: 0.0982, v: 0, first: true } },
      1: { cooldown: T(44), auto: true, spread: 0, dspread: { h: 0.0982, v: 0, first: false } },
      2: { cooldown: T(57), auto: true, spread: 0, dspread: { h: 0.1963, v: 0.1245, first: false } },
      3: { cooldown: T(4), auto: true, spread: 0, dspread: { h: 0.0982, v: 0, first: true } },
      4: { cooldown: T(20), auto: true, proj: { speed: 700 } },
      5: { cooldown: T(3), auto: true, spread: 0, proj: { speed: 875 } },
      6: { cooldown: T(60), auto: true, proj: { speed: 875, dmg: { base: 100, mult: 8 } } },
    },
  },
  modern: {
    name: 'modern', move: 'quake', eye: 48, canJump: true, gravity: 900, switchTicks: 10, autoAll: false, horizontalKnock: false, bobMax: 0, wpn: {},
  },
};
export const RULE_NAMES = Object.keys(RULESETS);
export const getRules = r => (r && typeof r === 'object' ? r : RULESETS[r] || RULESETS.modern);

const tableCache = new Map();
// weapon table with the ruleset's overrides merged in (cached per ruleset)
export function weaponTable(rules) {
  const key = rules.name;
  let t = tableCache.get(key);
  if (t) return t;
  t = WEAPONS.map(d => {
    const o = rules.wpn[d.id] || {};
    const out = { ...d, ...o };
    if (o.proj) out.proj = { ...d.proj, ...o.proj };
    return out;
  });
  tableCache.set(key, t);
  return t;
}
