// gfx.js - Doom graphics decoding: PLAYPAL, pictures (column posts), composite textures, flats, sprites,
// animation tables and mip-chain generation. CPU only, no GL.

export function loadPalette(wad) {
  const p = wad.lump('PLAYPAL');
  if (!p) throw new Error('no PLAYPAL');
  return p.subarray(0, 768);
}

// Doom "picture" format -> {w,h,left,top,rgba}
export function decodePicture(bytes, pal) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint16(0, true), h = dv.getUint16(2, true);
  const left = dv.getInt16(4, true), top = dv.getInt16(6, true);
  const rgba = new Uint8Array(w * h * 4);
  if (w === 0 || h === 0 || w > 4096 || h > 4096) return { w, h, left, top, rgba };
  for (let x = 0; x < w; x++) {
    let p = dv.getUint32(8 + x * 4, true);
    let lastTop = -1;
    while (p < bytes.length) {
      let td = bytes[p];
      if (td === 0xff) break;
      if (td <= lastTop && lastTop >= 0) td += lastTop; // DeePsea tall-patch relative offsets
      lastTop = td;
      const len = bytes[p + 1];
      p += 3;
      for (let i = 0; i < len; i++) {
        const y = td + i;
        if (y >= 0 && y < h && p + i < bytes.length) {
          const c = bytes[p + i] * 3, o = (y * w + x) * 4;
          rgba[o] = pal[c]; rgba[o + 1] = pal[c + 1]; rgba[o + 2] = pal[c + 2]; rgba[o + 3] = 255;
        }
      }
      p += len + 1;
    }
  }
  return { w, h, left, top, rgba };
}

export function decodeFlat(bytes, pal) {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 4096; i++) {
    const c = bytes[i] * 3;
    rgba[i * 4] = pal[c]; rgba[i * 4 + 1] = pal[c + 1]; rgba[i * 4 + 2] = pal[c + 2]; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

const td8 = new TextDecoder('latin1');
function name8(u8, o) {
  let e = o;
  while (e < o + 8 && u8[e] !== 0) e++;
  return td8.decode(u8.subarray(o, e)).toUpperCase();
}

// Parse TEXTURE1/TEXTURE2 + PNAMES -> Map(name -> {name,w,h,patches:[{x,y,name}]})
export function loadTextureDefs(wad) {
  const defs = new Map();
  const pn = wad.lump('PNAMES');
  if (!pn) return defs;
  const pdv = new DataView(pn.buffer, pn.byteOffset, pn.byteLength);
  const pcount = pdv.getInt32(0, true);
  const pnames = [];
  for (let i = 0; i < pcount; i++) pnames.push(name8(pn, 4 + i * 8));
  for (const lumpN of ['TEXTURE1', 'TEXTURE2']) {
    const t = wad.lump(lumpN);
    if (!t) continue;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const n = dv.getInt32(0, true);
    for (let i = 0; i < n; i++) {
      const o = dv.getInt32(4 + i * 4, true);
      const name = name8(t, o);
      const w = dv.getInt16(o + 12, true), h = dv.getInt16(o + 14, true);
      const pc = dv.getInt16(o + 20, true);
      const patches = [];
      for (let p = 0; p < pc; p++) {
        const po = o + 22 + p * 10;
        patches.push({ x: dv.getInt16(po, true), y: dv.getInt16(po + 2, true), name: pnames[dv.getInt16(po + 4, true)] });
      }
      defs.set(name, { name, w, h, patches });
    }
  }
  return defs;
}

export function compositeTexture(wad, def, pal, patchCache) {
  const { w, h } = def;
  const out = new Uint8Array(w * h * 4);
  for (const p of def.patches) {
    let pic = patchCache.get(p.name);
    if (!pic) {
      const lump = wad.lump(p.name);
      if (!lump) continue;
      pic = decodePicture(lump, pal);
      patchCache.set(p.name, pic);
    }
    for (let y = 0; y < pic.h; y++) {
      const dy = y + p.y;
      if (dy < 0 || dy >= h) continue;
      for (let x = 0; x < pic.w; x++) {
        const dx = x + p.x;
        if (dx < 0 || dx >= w) continue;
        const s = (y * pic.w + x) * 4;
        if (pic.rgba[s + 3] === 0) continue;
        const d = (dy * w + dx) * 4;
        out[d] = pic.rgba[s]; out[d + 1] = pic.rgba[s + 1]; out[d + 2] = pic.rgba[s + 2]; out[d + 3] = 255;
      }
    }
  }
  return out;
}

// name -> lump index of all flats (lumps of exactly 4096 bytes between *_START / *_END markers)
export function loadFlatIndex(wad) {
  const m = new Map();
  let inF = false;
  for (let i = 0; i < wad.lumps.length; i++) {
    const l = wad.lumps[i];
    if (/^F[F123]?_START$/.test(l.name)) { inF = true; continue; }
    if (/^F[F123]?_END$/.test(l.name)) { inF = false; continue; }
    if (inF && l.size === 4096) m.set(l.name, i);
  }
  return m;
}

// name -> lump index of all sprite lumps between S_START / S_END
export function loadSpriteIndex(wad) {
  const m = new Map();
  let inS = false;
  for (let i = 0; i < wad.lumps.length; i++) {
    const l = wad.lumps[i];
    if (/^S[S]?_START$/.test(l.name)) { inS = true; continue; }
    if (/^S[S]?_END$/.test(l.name)) { inS = false; continue; }
    if (inS && l.size > 8) m.set(l.name, i);
  }
  return m;
}

// Find a sprite lump for a name like 'PLAYA1' (or 'PLAYA0'). Handles mirrored lumps such as 'TROOA2A8'.
// Returns {lump:index, flip:bool, name} or null.
export function findSprite(spriteIndex, name) {
  name = name.toUpperCase();
  if (spriteIndex.has(name)) return { lump: spriteIndex.get(name), flip: false, name };
  const pre = name.slice(0, 5), rot = name[5] || '0';
  for (const [n, i] of spriteIndex) {
    if (n.length < 6 || n.slice(0, 5) !== pre) continue;
    if (n[5] === rot) return { lump: i, flip: false, name: n };
    if (n.length >= 8 && n[6] === pre[4] && n[7] === rot) return { lump: i, flip: true, name: n };
  }
  // rotation 0 request but only rotated frames exist, or vice versa
  for (const [n, i] of spriteIndex) {
    if (n.length >= 6 && n.slice(0, 5) === pre && (rot === '0' ? n[5] === '1' : n[5] === '0')) return { lump: i, flip: false, name: n };
  }
  return null;
}

// Standard Doom animation sequences (first, last). Applied only if every frame exists.
export const FLAT_ANIMS = [
  ['NUKAGE1', 'NUKAGE3'], ['FWATER1', 'FWATER4'], ['SWATER1', 'SWATER4'], ['LAVA1', 'LAVA4'], ['BLOOD1', 'BLOOD3'],
  ['RROCK05', 'RROCK08'], ['SLIME01', 'SLIME04'], ['SLIME05', 'SLIME08'], ['SLIME09', 'SLIME12'],
];
export const WALL_ANIMS = [
  ['BLODGR1', 'BLODGR4'], ['BLODRIP1', 'BLODRIP4'], ['FIREBLU1', 'FIREBLU2'], ['FIRELAV3', 'FIRELAVA'],
  ['FIREMAG1', 'FIREMAG3'], ['FIREWALA', 'FIREWALL'], ['GSTFONT1', 'GSTFONT3'], ['ROCKRED1', 'ROCKRED3'],
  ['SLADRIP1', 'SLADRIP3'], ['BFALL1', 'BFALL4'], ['SFALL1', 'SFALL4'], ['WFALL1', 'WFALL4'], ['DBRAIN1', 'DBRAIN4'],
];

// expand an (first,last) pair into the list of frame names
export function animFrames(first, last) {
  const m1 = /^(.*?)(\d|[A-Z])$/.exec(first), m2 = /^(.*?)(\d|[A-Z])$/.exec(last);
  if (!m1 || !m2) return null;
  const res = [];
  if (/\d$/.test(first) && /\d$/.test(last)) {
    const pad = first.length;
    const pa = /^(.*?)(\d+)$/.exec(first), pb = /^(.*?)(\d+)$/.exec(last);
    if (!pa || !pb || pa[1] !== pb[1]) return null;
    const a = +pa[2], b = +pb[2];
    for (let i = a; i <= b; i++) res.push(pa[1] + String(i).padStart(pad - pa[1].length, '0'));
    return res;
  }
  return [first, last];
}

// Generate mip levels (box filter, alpha weighted). Level k has size max(1,w>>k) x max(1,h>>k).
export function buildMips(rgba, w, h) {
  const levels = [{ w, h, data: rgba }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const s = levels[levels.length - 1];
    const nw = Math.max(1, s.w >> 1), nh = Math.max(1, s.h >> 1);
    const d = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(s.w - 1, x * 2 + dx), sy = Math.min(s.h - 1, y * 2 + dy);
            const o = (sy * s.w + sx) * 4;
            const al = s.data[o + 3];
            r += s.data[o] * al; g += s.data[o + 1] * al; b += s.data[o + 2] * al; a += al; n++;
          }
        }
        const o = (y * nw + x) * 4;
        if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; }
        d[o + 3] = a / n;
      }
    }
    levels.push({ w: nw, h: nh, data: d });
  }
  return levels;
}

// 3D RGB -> nearest PLAYPAL colour lookup table (size^3 RGBA8, index r + g*size + b*size*size)
export function buildPaletteLut(pal, size = 32) {
  const out = new Uint8Array(size * size * size * 4);
  const pc = new Float32Array(256 * 3);
  for (let i = 0; i < 768; i++) pc[i] = pal[i];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const R = (r + 0.5) / size * 255, G = (g + 0.5) / size * 255, B = (b + 0.5) / size * 255;
    let best = 0, bd = 1e12;
    for (let i = 0; i < 256; i++) {
      // weighted distance (redmean-ish) for a perceptually nicer match
      const dr = pc[i * 3] - R, dg = pc[i * 3 + 1] - G, db = pc[i * 3 + 2] - B;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = i; }
    }
    const o = (r + g * size + b * size * size) * 4;
    out[o] = pc[best * 3]; out[o + 1] = pc[best * 3 + 1]; out[o + 2] = pc[best * 3 + 2]; out[o + 3] = 255;
  }
  return out;
}
