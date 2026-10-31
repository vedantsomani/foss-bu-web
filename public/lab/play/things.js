// things.js - sprite / label tables for items and effect sequences.
// Pickup type -> [sprite prefix (frame A0), toast label, fullbright]
export const PICKUP_SPRITES = {
  2001: ['SHOT', 'Shotgun'], 2002: ['MGUN', 'Chaingun'], 2003: ['LAUN', 'Rocket launcher'], 2004: ['PLAS', 'Plasma rifle'], 2006: ['BFUG', 'BFG 9000'],
  82: ['SGN2', 'Super shotgun'], 2007: ['CLIP', 'Bullets'], 2008: ['SHEL', 'Shells'], 2010: ['ROCK', 'Rocket'], 2047: ['CELL', 'Cells'],
  2048: ['AMMO', 'Box of bullets'], 2049: ['SBOX', 'Box of shells'], 2046: ['BROK', 'Box of rockets'], 17: ['CELP', 'Cell pack'],
  2011: ['STIM', 'Stimpack'], 2012: ['MEDI', 'Medikit'], 2014: ['BON1', 'Health bonus'], 2015: ['BON2', 'Armor bonus'],
  2018: ['ARM1', 'Armor'], 2019: ['ARM2', 'Mega armor'], 83: ['MEGA', 'Megasphere', 1], 2013: ['SOUL', 'Supercharge', 1],
};
// short sprite animations: frames, seconds per frame, z offset of the sprite origin from the event position, fullbright, light
export const FX = {
  rocket: { frames: ['MISLB0', 'MISLC0', 'MISLD0'], dur: 0.11, dz: -22, fb: 1 },
  plasma: { frames: ['PLSEA0', 'PLSEB0', 'PLSEC0', 'PLSED0', 'PLSEE0'], dur: 0.05, dz: -10, fb: 1 },
  bfg: { frames: ['BFE1A0', 'BFE1B0', 'BFE1C0', 'BFE1D0', 'BFE1E0', 'BFE1F0'], dur: 0.08, dz: -40, fb: 1 },
  puff: { frames: ['PUFFA0', 'PUFFB0', 'PUFFC0', 'PUFFD0'], dur: 0.07, dz: -4, fb: 0 },
  blood: { frames: ['BLUDC0', 'BLUDB0', 'BLUDA0'], dur: 0.1, dz: -6, fb: 0 },
  tele: { frames: ['TFOGA0', 'TFOGB0', 'TFOGC0', 'TFOGD0', 'TFOGE0', 'TFOGF0', 'TFOGG0', 'TFOGH0', 'TFOGI0', 'TFOGJ0'], dur: 0.06, dz: 0, fb: 1 },
  itemfog: { frames: ['IFOGA0', 'IFOGB0', 'IFOGC0', 'IFOGD0', 'IFOGE0'], dur: 0.07, dz: 0, fb: 1 },
};
export const FIRE_SOUND = ['PISTOL', 'SHOTGN', 'DSHTGN', 'PISTOL', 'RLAUNC', 'PLASMA', 'BFG'];
export const PROJ = [null, null, null, null,
  { sprite: 'MISLA1', rot: true, dz: -8, radius: 230, color: [1, 0.6, 0.25], intensity: 1.1 },
  { sprite: 'PLSSA0', rot: false, dz: -8, radius: 180, color: [0.3, 0.5, 1], intensity: 1 },
  { sprite: 'BFS1A0', rot: false, dz: -14, radius: 300, color: [0.3, 1, 0.4], intensity: 1.4 }];
