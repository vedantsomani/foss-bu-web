// sprites.js - load FreeDM weapon sprites from the WAD into canvases (browser) or raw RGBA (tests).
import { readLumps, getPalette, decodePicture } from './wadlite.js';
import { SPRITE_FRAMES } from './weapons.js';

export function weaponLumpNames() {
  const out = new Set();
  for (const f of Object.values(SPRITE_FRAMES)) { f.gun.forEach(n => out.add(n)); f.flash.forEach(n => out.add(n)); }
  return [...out];
}
// returns { LUMP: {width,height,left,top,rgba, canvas?} }
export function loadWeaponSprites(wadArrayBuffer, makeCanvas) {
  const wad = readLumps(wadArrayBuffer), pal = getPalette(wad), out = {};
  for (const name of weaponLumpNames()) {
    const pic = decodePicture(wad, name, pal);
    if (!pic) continue;
    if (makeCanvas) {
      const c = makeCanvas(pic.width, pic.height), g = c.getContext('2d');
      g.putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
      pic.canvas = c;
    }
    out[name] = pic;
  }
  return out;
}
