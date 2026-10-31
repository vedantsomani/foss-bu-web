// doomgfx.js - Doom picture lumps as canvases, the STCFN font and the status-bar number fonts, all read from the (merged) WAD.
import { readLumps, getPalette, decodePicture } from '../game/wadlite.js';

export class DoomGfx {
  constructor(wad, makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }) {
    this.wad = wad; this.lw = readLumps(wad.buffer); this.pal = getPalette(this.lw); this.mk = makeCanvas;
    this.cache = new Map(); this.tints = new Map();
  }
  has(name) { return this.lw.byName.has(name); }
  // -> {w, h, left, top, canvas} or null
  pic(name) {
    let p = this.cache.get(name);
    if (p !== undefined) return p;
    const d = this.lw.byName.has(name) ? decodePicture(this.lw, name, this.pal) : null;
    if (d) {
      const c = this.mk(d.width, d.height); c.getContext('2d').putImageData(new ImageData(d.rgba, d.width, d.height), 0, 0);
      p = { w: d.width, h: d.height, left: d.left, top: d.top, canvas: c };
    } else p = null;
    this.cache.set(name, p); return p;
  }
  // draw at virtual (x, y) honouring the picture's offsets when `offs` is set (sprites); menu/status-bar pictures use plain x,y
  draw(g, name, x, y, offs = false) {
    const p = this.pic(name); if (!p) return 0;
    g.drawImage(p.canvas, offs ? x - p.left : x, offs ? y - p.top : y); return p.w;
  }
  glyph(ch) {   // STCFN033.. (upper case only, like vanilla)
    let c = ch.charCodeAt(0); if (c >= 97 && c <= 122) c -= 32;
    return c > 32 && c < 127 ? this.pic('STCFN' + String(c).padStart(3, '0')) : null;
  }
  textWidth(s) { let w = 0; for (const ch of s) { const g = this.glyph(ch); w += g ? g.w : 4; } return w; }
  tinted(ch, color) {
    const key = ch + color; let c = this.tints.get(key); if (c) return c;
    const g = this.glyph(ch); if (!g) return null;
    c = this.mk(g.w, g.h); const x = c.getContext('2d');
    x.drawImage(g.canvas, 0, 0); x.globalCompositeOperation = 'multiply'; x.fillStyle = color; x.fillRect(0, 0, g.w, g.h);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(g.canvas, 0, 0);
    this.tints.set(key, c); return c;
  }
  // text in the Doom font; color = CSS colour for a tint (omit for the lump's own grey/white)
  text(g, s, x, y, color) {
    for (const ch of s) {
      const gl = this.glyph(ch);
      if (!gl) { x += 4; continue; }
      g.drawImage(color ? this.tinted(ch, color) : gl.canvas, x, y); x += gl.w;
    }
    return x;
  }
  textC(g, s, cx, y, color) { this.text(g, s, Math.round(cx - this.textWidth(s) / 2), y, color); }
  // numbers with a digit set: 'STTNUM' (big red), 'STYSNUM' (small yellow), 'STGNUM' (small grey). Right aligned at x.
  number(g, n, xRight, y, set = 'STTNUM', minDigits = 1, pct = false) {
    n = Math.trunc(n); const neg = n < 0; let str = String(Math.abs(n)); while (str.length < minDigits) str = ' ' + str;
    const w0 = this.pic(set + '0'); if (!w0) return;
    let x = xRight;
    if (pct) { const p = this.pic('STTPRCNT'); if (p) { x -= p.w; g.drawImage(p.canvas, x, y); } }
    for (let i = str.length - 1; i >= 0; i--) { x -= w0.w; if (str[i] !== ' ') g.drawImage(this.pic(set + str[i]).canvas, x, y); }
    if (neg) { const m = this.pic('STTMINUS'); if (m) { x -= m.w; g.drawImage(m.canvas, x, y + 0); } }
  }
}
