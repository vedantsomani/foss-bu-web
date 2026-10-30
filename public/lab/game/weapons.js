// weapons.js - data-driven weapon table. Units: Doom map units, ticks at 60 Hz.
// ammo types: 0 bullets, 1 shells, 2 rockets, 3 cells
export const AMMO_NAMES = ['bullets', 'shells', 'rockets', 'cells'];
export const AMMO_MAX = [200, 50, 50, 300];

export const W = { PISTOL: 0, SHOTGUN: 1, SSG: 2, CHAINGUN: 3, ROCKET: 4, PLASMA: 5, BFG: 6 };

// dmg: base * (1 + floor(rand*mult))  (Doom style 5/10/15, 20..160 ...)
// recoil: viewmodel kick (pitch radians-ish units used by viewmodel.js), shake: screen units
export const WEAPONS = [
  { id: 0, name: 'Pistol', slot: 2, sprite: 'PIS', ammoType: 0, cost: 1, cooldown: 24, auto: false, kind: 'hitscan',
    pellets: 1, spread: 0.012, dmg: { base: 5, mult: 3 }, range: 4096, recoil: 0.6, flashTicks: 4, pump: false, startAmmo: 0, pickupAmmo: 0 },
  { id: 1, name: 'Shotgun', slot: 3, sprite: 'SHT', ammoType: 1, cost: 1, cooldown: 60, auto: false, kind: 'hitscan',
    pellets: 7, spread: 0.055, dmg: { base: 5, mult: 3 }, range: 2048, recoil: 1.6, flashTicks: 5, pump: true, pickupAmmo: 8 },
  { id: 2, name: 'Super Shotgun', slot: 3, sprite: 'SHT2', ammoType: 1, cost: 2, cooldown: 90, auto: false, kind: 'hitscan',
    pellets: 20, spread: 0.09, dmg: { base: 5, mult: 3 }, range: 2048, recoil: 2.6, flashTicks: 6, pump: true, pickupAmmo: 8 },
  { id: 3, name: 'Chaingun', slot: 4, sprite: 'CHG', ammoType: 0, cost: 1, cooldown: 7, auto: true, kind: 'hitscan',
    pellets: 1, spread: 0.03, dmg: { base: 5, mult: 3 }, range: 4096, recoil: 0.5, flashTicks: 3, pump: false, pickupAmmo: 20 },
  { id: 4, name: 'Rocket Launcher', slot: 5, sprite: 'MIS', ammoType: 2, cost: 1, cooldown: 34, auto: false, kind: 'projectile',
    proj: { speed: 720, radius: 6, dmg: { base: 20, mult: 8 }, splash: 128, splashRadius: 128, ttl: 300 },
    pellets: 1, spread: 0, range: 0, recoil: 2.0, flashTicks: 5, pump: false, pickupAmmo: 2 },
  { id: 5, name: 'Plasma Rifle', slot: 6, sprite: 'PLS', ammoType: 3, cost: 1, cooldown: 6, auto: true, kind: 'projectile',
    proj: { speed: 1500, radius: 5, dmg: { base: 5, mult: 8 }, splash: 0, splashRadius: 0, ttl: 180 },
    pellets: 1, spread: 0.006, range: 0, recoil: 0.4, flashTicks: 3, pump: false, pickupAmmo: 40 },
  { id: 6, name: 'BFG 9000', slot: 7, sprite: 'BFG', ammoType: 3, cost: 40, cooldown: 70, auto: false, kind: 'projectile',
    proj: { speed: 800, radius: 8, dmg: { base: 100, mult: 4 }, splash: 200, splashRadius: 192, ttl: 240 },
    pellets: 1, spread: 0, range: 0, recoil: 3.0, flashTicks: 8, pump: false, pickupAmmo: 40 },
];

// Sprite lump names used by the viewmodel: <sprite>G<frame>0 idle/fire frames, <sprite>F<frame>0 flash
export const SPRITE_FRAMES = {
  0: { gun: ['PISGA0', 'PISGB0', 'PISGC0', 'PISGD0'], flash: ['PISFA0'] },
  1: { gun: ['SHTGA0', 'SHTGB0', 'SHTGC0', 'SHTGD0'], flash: ['SHTFA0', 'SHTFB0'] },
  2: { gun: ['SHT2A0', 'SHT2B0', 'SHT2C0', 'SHT2D0', 'SHT2E0', 'SHT2F0', 'SHT2G0', 'SHT2H0'], flash: ['SHT2I0', 'SHT2J0'] },
  3: { gun: ['CHGGA0', 'CHGGB0'], flash: ['CHGFA0', 'CHGFB0'] },
  4: { gun: ['MISGA0', 'MISGB0'], flash: ['MISFA0', 'MISFB0', 'MISFC0', 'MISFD0'] },
  5: { gun: ['PLSGA0', 'PLSGB0'], flash: ['PLSFA0', 'PLSFB0'] },
  6: { gun: ['BFGGA0', 'BFGGB0', 'BFGGC0'], flash: ['BFGFA0', 'BFGFB0'] },
};

export const START_WEAPONS = 1 << W.PISTOL;
export const START_AMMO = [50, 0, 0, 0];

// Pickup table keyed by Doom thing type
export const RESPAWN_TICKS = 1800, RESPAWN_POWER = 7200;
export const ITEMS = {
  2001: { weapon: W.SHOTGUN }, 82: { weapon: W.SSG }, 2002: { weapon: W.CHAINGUN }, 2003: { weapon: W.ROCKET },
  2004: { weapon: W.PLASMA }, 2006: { weapon: W.BFG },
  2007: { ammo: [0, 10] }, 2048: { ammo: [0, 50] }, 2008: { ammo: [1, 4] }, 2049: { ammo: [1, 20] },
  2010: { ammo: [2, 1] }, 2046: { ammo: [2, 5] }, 2047: { ammo: [3, 20] }, 17: { ammo: [3, 100] },
  2011: { health: 10, max: 100 }, 2012: { health: 25, max: 100 }, 2014: { health: 1, max: 200 },
  2013: { health: 100, max: 200, power: true },
  2015: { armorAdd: 1, max: 200 }, 2018: { armorSet: 100, type: 1 }, 2019: { armorSet: 200, type: 2 },
  83: { health: 200, max: 200, armorSet: 200, type: 2, power: true },
};
