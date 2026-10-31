// renderer.js - WebGL2 renderer for Doom-format maps ("Fragline lab").
//
//   const r = createRenderer(canvas, wad, map, options);
//   r.setCamera({x,y,z,angle,pitch,fov}); r.setEntities([...]); r.render(dt, alpha?);
//
// Live sector heights: r.setSectorHeights(floors, ceils) (Float32Array/Array in Doom units) may be called every frame; geometry is
// never rebuilt (vertices follow per-sector height slots that are displaced in the vertex shader).
// See README-style notes at the bottom of the file for the option list.

import { pointInSector } from '../wad.js';
import {
  loadPalette, decodePicture, decodeFlat, loadTextureDefs, compositeTexture, loadFlatIndex, loadSpriteIndex,
  findSprite, FLAT_ANIMS, WALL_ANIMS, animFrames, buildMips, buildPaletteLut,
} from './gfx.js';
import { Registry, buildGeometry, FLOATS_PER_VERTEX } from './geometry.js';
import {
  GEO_VS, GEO_FS, SKY_VS, SKY_FS, SPR_VS, SPR_FS, POST_VS, BRIGHT_FS, BLUR_FS, COMPOSITE_FS,
} from './shaders.js';

// Doom editor number -> [sprite prefix, frame letter, fullbright]
const THING_SPRITES = {
  2001: ['SHOT', 'A'], 2002: ['MGUN', 'A'], 2003: ['LAUN', 'A'], 2004: ['PLAS', 'A'], 2005: ['CSAW', 'A'],
  2006: ['BFUG', 'A'], 82: ['SGN2', 'A'], 2007: ['CLIP', 'A'], 2008: ['SHEL', 'A'], 2010: ['ROCK', 'A'],
  2047: ['CELL', 'A'], 2048: ['AMMO', 'A'], 2049: ['SBOX', 'A'], 2046: ['BROK', 'A'], 17: ['CELP', 'A'],
  2011: ['STIM', 'A'], 2012: ['MEDI', 'A'], 2014: ['BON1', 'A'], 2015: ['BON2', 'A'], 2018: ['ARM1', 'A'],
  2019: ['ARM2', 'A'], 2022: ['PINV', 'A', 1], 2023: ['PSTR', 'A'], 2024: ['PINS', 'A', 1], 2025: ['SUIT', 'A'],
  2026: ['PMAP', 'A', 1], 2045: ['PVIS', 'A', 1], 83: ['MEGA', 'A', 1], 2013: ['SOUL', 'A', 1], 8: ['BPAK', 'A'],
  5: ['BKEY', 'A'], 6: ['YKEY', 'A'], 13: ['RKEY', 'A'], 38: ['RSKU', 'A'], 39: ['YSKU', 'A'], 40: ['BSKU', 'A'],
  2028: ['COLU', 'A', 1], 2035: ['BAR1', 'A'], 48: ['ELEC', 'A'], 30: ['COL1', 'A'], 31: ['COL2', 'A'],
  32: ['COL3', 'A'], 33: ['COL4', 'A'], 34: ['CAND', 'A', 1], 35: ['CBRA', 'A', 1], 36: ['COL5', 'A'],
  37: ['COL6', 'A'], 41: ['CEYE', 'A', 1], 42: ['FSKU', 'A', 1], 43: ['TRE1', 'A'], 44: ['TBLU', 'A', 1],
  45: ['TGRN', 'A', 1], 46: ['TRED', 'A', 1], 47: ['SMIT', 'A'], 54: ['TRE2', 'A'], 55: ['SMBT', 'A', 1],
  56: ['SMGT', 'A', 1], 57: ['SMRT', 'A', 1], 70: ['FCAN', 'A', 1], 85: ['TLMP', 'A', 1], 86: ['TLP2', 'A', 1],
  24: ['POL5', 'A'], 25: ['POL1', 'A'], 26: ['POL6', 'A'], 27: ['POL4', 'A'], 28: ['POL2', 'A'], 29: ['POL3', 'A'],
  49: ['GOR1', 'A'], 50: ['GOR2', 'A'], 51: ['GOR3', 'A'], 52: ['GOR4', 'A'], 53: ['GOR5', 'A'],
  59: ['GOR2', 'A'], 60: ['GOR4', 'A'], 61: ['GOR3', 'A'], 62: ['GOR5', 'A'], 63: ['GOR1', 'A'],
  73: ['HDB1', 'A'], 74: ['HDB2', 'A'], 75: ['HDB3', 'A'], 76: ['HDB4', 'A'], 77: ['HDB5', 'A'], 78: ['HDB6', 'A'],
  79: ['POB1', 'A'], 80: ['POB2', 'A'], 81: ['BRS1', 'A'], 10: ['PLAY', 'W'], 12: ['PLAY', 'W'], 15: ['PLAY', 'N'],
  18: ['POSS', 'L'], 19: ['SPOS', 'L'], 20: ['TROO', 'M'], 21: ['SARG', 'N'], 22: ['HEAD', 'L'], 23: ['SKUL', 'K'],
  3004: ['POSS', 'A'], 9: ['SPOS', 'A'], 3001: ['TROO', 'A'], 3002: ['SARG', 'A'], 3005: ['HEAD', 'A'],
};

const DEFAULTS = {
  renderScale: 1,        // internal resolution relative to the canvas backing store (0.25 .. 2)
  dpr: null,             // null -> min(devicePixelRatio, 2)
  fov: 90,               // horizontal FOV (degrees) of a 4:3 view; wider windows get hor+
  pixelStretch: 1.2,     // vanilla Doom's 1.2 non-square pixel (taller world); 1 = pure perspective
  bloom: true, bloomStrength: 0.7, bloomThreshold: 0.62,
  classic: false,        // quantise to PLAYPAL through a 3D LUT + banded light levels
  fogDensity: 0.00035, fogColor: [0.03, 0.035, 0.06],
  ambient: 0.045, lightGain: 1.0, gamma: 1.0, vignette: 0.25, lodBias: 0,
  things: true, animate: true, sectorEffects: true,
  sky: null, noOcclusion: false, maxLights: 16, clipZ: 1e9, // clipZ: debug, hides geometry above this height
  preserveDrawingBuffer: false, syncTiming: false,
};

function pow2ceil(n) { let p = 1; while (p < n) p <<= 1; return p; }
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; }

function parseColor(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  if (typeof c === 'number') return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  if (typeof c === 'string') { const n = parseInt(c.replace('#', ''), 16); return parseColor(n); }
  if (c && typeof c === 'object') return [c.r ?? 1, c.g ?? 1, c.b ?? 1];
  return [1, 1, 1];
}

export function createRenderer(canvas, wad, map, userOptions = {}) {
  const opt = Object.assign({}, DEFAULTS, userOptions);
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false,
    powerPreference: 'high-performance', desynchronized: true, preserveDrawingBuffer: !!opt.preserveDrawingBuffer,
  });
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_float');
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  // ---------------------------------------------------------------- GL helpers
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    return s;
  };
  const programs = [];
  const makeProgram = (vs, fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
    const prog = { p, u };
    programs.push(prog);
    return prog;
  };

  // ---------------------------------------------------------------- assets
  const pal = loadPalette(wad);
  const texDefs = loadTextureDefs(wad);
  const flatIndex = loadFlatIndex(wad);
  const spriteIndex = loadSpriteIndex(wad);

  const groupsFor = (table, exists) => {
    const gs = [];
    for (const [a, b] of table) {
      const fr = animFrames(a, b);
      if (fr && fr.every(exists)) gs.push(fr);
    }
    return gs;
  };
  const wallReg = new Registry((n) => { const d = texDefs.get(n); return d && d.w > 0 && d.h > 0 ? { w: d.w, h: d.h } : null; },
    groupsFor(WALL_ANIMS, (n) => texDefs.has(n)));
  const flatReg = new Registry((n) => (flatIndex.has(n) ? { w: 64, h: 64 } : null), groupsFor(FLAT_ANIMS, (n) => flatIndex.has(n)));

  const geo = buildGeometry(map, wallReg, flatReg);
  const nsec = map.sectors.length;

  // ---- static tables for the BSP walk, live heights and light visibility
  const NL = geo.nLines, NSS = geo.nSubsectors;
  const nodes = map.nodes, segs = map.segs, subs = map.subsectors, mverts = map.vertices, mlines = map.linedefs, msides = map.sidedefs;
  const haveBsp = nodes.length > 0 && subs.length > 0 && segs.length > 0;
  const baseF = new Float32Array(nsec), baseC = new Float32Array(nsec), liveF = new Float32Array(nsec), liveC = new Float32Array(nsec);
  for (let i = 0; i < nsec; i++) { baseF[i] = liveF[i] = map.sectors[i].floor; baseC[i] = liveC[i] = map.sectors[i].ceil; }
  const slotRows = Math.max(1, Math.ceil(nsec * 2 / 256));
  const deltaArr = new Float32Array(256 * slotRows);           // live - map height per slot (sector*2 + floor|ceil)
  const secZLo = new Float32Array(nsec), secZHi = new Float32Array(nsec);
  let zLo = 0, zHi = 0, deltaDirty = true, zDirty = true;
  const ldFs = new Int32Array(NL), ldBs = new Int32Array(NL);
  const ldAx = new Float32Array(NL), ldAy = new Float32Array(NL), ldBx = new Float32Array(NL), ldBy = new Float32Array(NL);
  mlines.forEach((ld, i) => {
    ldFs[i] = ld.front >= 0 ? msides[ld.front].sector : -1; ldBs[i] = ld.back >= 0 ? msides[ld.back].sector : -1;
    const a = mverts[ld.v1], b = mverts[ld.v2];
    if (a && b) { ldAx[i] = a.x; ldAy[i] = a.y; ldBx[i] = b.x; ldBy[i] = b.y; }
  });
  const sgX1 = new Float32Array(segs.length), sgY1 = new Float32Array(segs.length), sgX2 = new Float32Array(segs.length), sgY2 = new Float32Array(segs.length);
  const sgUnit = new Int32Array(segs.length), sgLd = new Int32Array(segs.length);
  segs.forEach((sg, i) => {
    const a = mverts[sg.v1], b = mverts[sg.v2], ld = mlines[sg.linedef];
    sgLd[i] = sg.linedef; sgUnit[i] = !a || !b || !ld || (sg.side ? ld.back : ld.front) < 0 ? -1 : sg.linedef * 2 + (sg.side ? 1 : 0);
    if (a && b) { sgX1[i] = a.x; sgY1[i] = a.y; sgX2[i] = b.x; sgY2[i] = b.y; }
  });
  // node boxes (minx, miny, maxx, maxy) for the right then the left child. Built bottom-up from the subsector boxes (which include the
  // floor/ceiling polygons) because the BSP's own bounding boxes only cover segs and would cull polygons that reach beyond them.
  const nodeBox = new Float32Array(nodes.length * 8);
  // iterative post-order (child indices are always smaller than their parent in Doom BSPs, but do not rely on it)
  { const done = new Uint8Array(nodes.length), st = [];
    for (let root = nodes.length - 1; root >= 0; root--) {
      if (done[root]) continue;
      st.push(root);
      while (st.length) {
        const c = st[st.length - 1], n = nodes[c];
        let ready = true;
        for (const ch of [n.right, n.left]) if (!(ch & 0x8000) && !done[ch]) { st.push(ch); ready = false; }
        if (!ready) continue;
        st.pop();
        if (done[c]) continue;
        const rb = new Float32Array(4), lb = new Float32Array(4);
        const get = (ch, o) => { if (ch & 0x8000) { const i = (ch === 0xffff ? 0 : ch & 0x7fff) * 4; for (let k = 0; k < 4; k++) o[k] = geo.ssBox[i + k]; } else { const a = ch * 8; o[0] = Math.min(nodeBox[a], nodeBox[a + 4]); o[1] = Math.min(nodeBox[a + 1], nodeBox[a + 5]); o[2] = Math.max(nodeBox[a + 2], nodeBox[a + 6]); o[3] = Math.max(nodeBox[a + 3], nodeBox[a + 7]); } };
        get(n.right, rb); get(n.left, lb);
        nodeBox.set([rb[0] - 1, rb[1] - 1, rb[2] + 1, rb[3] + 1, lb[0] - 1, lb[1] - 1, lb[2] + 1, lb[3] + 1], c * 8);
        done[c] = 1;
      }
    }
  }
  // sector adjacency over two-sided lines (light flood)
  const adjStart = new Int32Array(nsec + 1);
  for (let i = 0; i < NL; i++) if (ldFs[i] >= 0 && ldBs[i] >= 0 && ldFs[i] !== ldBs[i]) { adjStart[ldFs[i] + 1]++; adjStart[ldBs[i] + 1]++; }
  for (let i = 0; i < nsec; i++) adjStart[i + 1] += adjStart[i];
  const adjNb = new Int32Array(adjStart[nsec]), adjLd = new Int32Array(adjStart[nsec]), adjFill = adjStart.slice(0, nsec);
  for (let i = 0; i < NL; i++) if (ldFs[i] >= 0 && ldBs[i] >= 0 && ldFs[i] !== ldBs[i]) {
    adjNb[adjFill[ldFs[i]]] = ldBs[i]; adjLd[adjFill[ldFs[i]]++] = i; adjNb[adjFill[ldBs[i]]] = ldFs[i]; adjLd[adjFill[ldBs[i]]++] = i;
  }

  // --- texture arrays (nearest, manual mip selection in the shader via texelFetch)
  function makeTexArray(unit, items, S) {
    const n = Math.max(1, items.length);
    const levels = Math.log2(S) + 1;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const mips = items.map((it) => buildMips(it.rgba, it.w, it.h));
    for (let k = 0; k < levels; k++) {
      const sz = Math.max(1, S >> k);
      const buf = new Uint8Array(sz * sz * n * 4);
      for (let li = 0; li < items.length; li++) {
        const lv = mips[li][k];
        if (!lv) continue;
        const base = li * sz * sz * 4;
        for (let y = 0; y < lv.h; y++) buf.set(lv.data.subarray(y * lv.w * 4, (y + 1) * lv.w * 4), base + y * sz * 4);
      }
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, k, gl.RGBA8, sz, sz, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  const patchCache = new Map();
  const wallItems = wallReg.entries.map((e) => ({ rgba: compositeTexture(wad, texDefs.get(e.name), pal, patchCache), w: e.w, h: e.h }));
  const flatItems = flatReg.entries.map((e) => ({ rgba: decodeFlat(wad.lumpAt(flatIndex.get(e.name)), pal), w: 64, h: 64 }));
  const wallS = Math.max(16, pow2ceil(Math.max(1, ...wallReg.entries.map((e) => Math.max(e.w, e.h)))));
  const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
  if (wallItems.length > maxLayers) console.warn('too many wall textures for this GPU', wallItems.length);
  const U_WALL = 0, U_FLAT = 1, U_WINFO = 2, U_FINFO = 3, U_SECL = 4, U_SKY = 5, U_ATLAS = 6, U_SCENE = 7, U_BLOOM = 8, U_LUT = 9, U_DELTA = 10;
  const wallTex = makeTexArray(U_WALL, wallItems, wallS);
  const flatTex = makeTexArray(U_FLAT, flatItems, 64);

  // info textures: per logical id -> (layer, w, h)
  function makeInfo(unit, reg) {
    const n = Math.max(1, reg.entries.length);
    const data = new Float32Array(n * 4);
    reg.entries.forEach((e, i) => { data[i * 4] = i; data[i * 4 + 1] = e.w; data[i * 4 + 2] = e.h; });
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { tex, data, n, unit, reg };
  }
  const wallInfo = makeInfo(U_WINFO, wallReg);
  const flatInfo = makeInfo(U_FINFO, flatReg);
  function setAnimFrame(info, tic) {
    for (const g of info.reg.groups) {
      const n = g.length;
      for (let i = 0; i < n; i++) {
        const src = g[(i + tic) % n];
        info.data[g[i] * 4] = src; info.data[g[i] * 4 + 1] = info.reg.entries[src].w; info.data[g[i] * 4 + 2] = info.reg.entries[src].h;
      }
    }
    gl.activeTexture(gl.TEXTURE0 + info.unit);
    gl.bindTexture(gl.TEXTURE_2D, info.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, info.n, 1, gl.RGBA, gl.FLOAT, info.data);
  }

  // --- sector light texture
  const secRows = Math.max(1, Math.ceil(nsec / 256));
  const secLight = new Float32Array(256 * secRows * 2);   // per sector: R = light level, G = bitmask of dynamic lights that can reach it
  const secMask = new Int32Array(nsec);
  const secLightTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + U_SECL);
  gl.bindTexture(gl.TEXTURE_2D, secLightTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, 256, secRows, 0, gl.RG, gl.FLOAT, secLight);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  // live height deltas (R32F, 256 slots per row)
  const deltaTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + U_DELTA);
  gl.bindTexture(gl.TEXTURE_2D, deltaTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, slotRows, 0, gl.RED, gl.FLOAT, deltaArr);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // sector light effects (Doom light specials)
  const minNeighbor = new Float32Array(nsec);
  const effects = []; // {s, type}
  {
    for (let i = 0; i < nsec; i++) minNeighbor[i] = map.sectors[i].light;
    for (const ld of map.linedefs) {
      if (ld.front < 0 || ld.back < 0) continue;
      const a = map.sidedefs[ld.front].sector, b = map.sidedefs[ld.back].sector;
      minNeighbor[a] = Math.min(minNeighbor[a], map.sectors[b].light);
      minNeighbor[b] = Math.min(minNeighbor[b], map.sectors[a].light);
    }
    map.sectors.forEach((s, i) => { if ([1, 2, 3, 4, 8, 12, 13, 17].includes(s.special)) effects.push({ s: i, type: s.special }); });
  }
  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = Math.imul(n + (n << 3), 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967296; };
  function updateSectorLight(time) {
    for (let i = 0; i < nsec; i++) secLight[i * 2] = map.sectors[i].light;
    if (opt.sectorEffects) {
      const tic = Math.floor(time * 35);
      for (const e of effects) {
        const S = map.sectors[e.s], hi = S.light, lo = minNeighbor[e.s];
        let v = hi;
        switch (e.type) {
          case 1: v = hash(Math.floor(tic / 4) * 977 + e.s) < 0.35 ? lo : hi; break;
          case 2: case 4: case 12: { const ph = (tic + (e.type === 12 ? 0 : e.s * 7)) % 20; v = ph < 5 ? hi : lo; break; }
          case 3: case 13: { const ph = (tic + (e.type === 13 ? 0 : e.s * 7)) % 40; v = ph < 5 ? hi : lo; break; }
          case 8: { const span = Math.max(8, hi - lo), per = (span / 8) * 2, ph = (tic % per) / per; v = lo + span * (1 - Math.abs(ph * 2 - 1)); v = Math.min(hi, v); break; }
          case 17: v = Math.max(lo, hi - Math.floor(hash(Math.floor(tic / 4) * 131 + e.s) * 4) * 16); break;
        }
        secLight[e.s * 2] = v;
      }
    }
  }
  function uploadSectorLight() {
    for (let i = 0; i < nsec; i++) secLight[i * 2 + 1] = secMask[i];
    gl.activeTexture(gl.TEXTURE0 + U_SECL);
    gl.bindTexture(gl.TEXTURE_2D, secLightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, secRows, gl.RG, gl.FLOAT, secLight);
  }

  // --- sky
  const mapNum = parseInt((map.name.match(/\d+/) || ['1'])[0], 10);
  const skyName = opt.sky || (mapNum >= 21 ? 'SKY3' : mapNum >= 12 ? 'SKY2' : 'SKY1');
  let skyPic = null;
  {
    const names = [skyName, 'SKY1'];
    for (const n of names) {
      if (texDefs.has(n)) { const d = texDefs.get(n); skyPic = { w: d.w, h: d.h, rgba: compositeTexture(wad, d, pal, patchCache) }; break; }
      const l = wad.lump(n);
      if (l) { skyPic = decodePicture(l, pal); break; }
    }
    if (!skyPic) { skyPic = { w: 1, h: 1, rgba: new Uint8Array([40, 60, 120, 255]) }; }
  }
  const skyTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + U_SKY);
  gl.bindTexture(gl.TEXTURE_2D, skyTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, skyPic.w, skyPic.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, skyPic.rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // --- sprite atlas (shelf packed, lazily filled)
  const ATLAS = 2048;
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + U_ATLAS);
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, ATLAS, ATLAS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let shelfX = 0, shelfY = 0, shelfH = 0;
  const spriteCache = new Map();
  function getSprite(name) {
    let s = spriteCache.get(name);
    if (s !== undefined) return s;
    const f = findSprite(spriteIndex, name);
    if (!f) { spriteCache.set(name, null); return null; }
    const pic = decodePicture(wad.lumpAt(f.lump), pal);
    if (pic.w === 0 || pic.h === 0) { spriteCache.set(name, null); return null; }
    if (shelfX + pic.w + 1 > ATLAS) { shelfX = 0; shelfY += shelfH + 1; shelfH = 0; }
    if (shelfY + pic.h > ATLAS) { console.warn('sprite atlas full'); spriteCache.set(name, null); return null; }
    gl.activeTexture(gl.TEXTURE0 + U_ATLAS);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, shelfX, shelfY, pic.w, pic.h, gl.RGBA, gl.UNSIGNED_BYTE, pic.rgba);
    const u0 = shelfX / ATLAS, u1 = (shelfX + pic.w) / ATLAS, v0 = shelfY / ATLAS, v1 = (shelfY + pic.h) / ATLAS;
    s = { u0: f.flip ? u1 : u0, u1: f.flip ? u0 : u1, v0, v1, w: pic.w, h: pic.h, left: f.flip ? pic.w - pic.left : pic.left, top: pic.top };
    shelfX += pic.w + 1; shelfH = Math.max(shelfH, pic.h);
    spriteCache.set(name, s);
    return s;
  }

  // static map things
  const staticThings = [];
  if (opt.things) {
    for (const t of map.things) {
      const def = THING_SPRITES[t.type];
      if (!def) continue;
      if (!(t.flags & 7) || (t.flags & 0x20)) continue; // not in any skill / not in deathmatch
      const sec = pointInSector(map, t.x, t.y);
      if (sec < 0) continue;
      const name = def[0] + def[1] + '0';
      if (!getSprite(name)) continue;
      staticThings.push({ x: t.x, y: t.y, z: map.sectors[sec].floor, sec, name, fb: def[2] ? 1 : 0, spr: getSprite(name) });
    }
  }

  // ---------------------------------------------------------------- programs & buffers
  const progGeo = makeProgram(GEO_VS, GEO_FS(false));
  const progMasked = makeProgram(GEO_VS, GEO_FS(true));
  const progSky = makeProgram(SKY_VS, SKY_FS);
  const progSpr = makeProgram(SPR_VS, SPR_FS);
  const progBright = makeProgram(POST_VS, BRIGHT_FS);
  const progBlur = makeProgram(POST_VS, BLUR_FS);
  const progComp = makeProgram(POST_VS, COMPOSITE_FS);

  const emptyVao = gl.createVertexArray();
  const STRIDE = FLOATS_PER_VERTEX * 4;
  function makeBatch(data, prog, kind) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, STRIDE, 28);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, STRIDE, 32);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 1, gl.FLOAT, false, STRIDE, 36);
    gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 1, gl.FLOAT, false, STRIDE, 40);
    gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 1, gl.FLOAT, false, STRIDE, 44);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Math.max(4, data.indices.byteLength), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    return { data, prog, kind, vao, vbo, ibo, frame: new Uint32Array(Math.max(1, data.indices.length)), count: 0 };
  }
  // opaque first (front-to-back lists + depth test = early-z), alpha-tested mid textures after, sky last
  const batches = [
    makeBatch(geo.batches.wall, progGeo, 'wall'),
    makeBatch(geo.batches.flat, progGeo, 'flat'),
    makeBatch(geo.batches.masked, progMasked, 'masked'),
    makeBatch(geo.batches.sky, progSky, 'sky'),
  ];

  // sprites: dynamic vertex buffer (pos3, uv2, light, fb) + static quad index buffer
  const SPR_FLOATS = 8, MAX_SPRITES = 4096;
  let sprData = new Float32Array(MAX_SPRITES * 4 * SPR_FLOATS);
  const sprVao = gl.createVertexArray();
  gl.bindVertexArray(sprVao);
  const sprVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, sprVbo);
  gl.bufferData(gl.ARRAY_BUFFER, sprData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, SPR_FLOATS * 4, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, SPR_FLOATS * 4, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, SPR_FLOATS * 4, 20);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, SPR_FLOATS * 4, 24);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, SPR_FLOATS * 4, 28);
  const sprIbo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sprIbo);
  {
    const idx = new Uint16Array(MAX_SPRITES * 6);
    for (let i = 0; i < MAX_SPRITES; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }
  gl.bindVertexArray(null);

  // ---------------------------------------------------------------- render targets
  const sNearest = gl.createSampler();
  gl.samplerParameteri(sNearest, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.samplerParameteri(sNearest, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.samplerParameteri(sNearest, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(sNearest, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const sLinear = gl.createSampler();
  gl.samplerParameteri(sLinear, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.samplerParameteri(sLinear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.samplerParameteri(sLinear, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(sLinear, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const rt = { w: 0, h: 0, sceneTex: null, depth: null, sceneFbo: null, bw: 0, bh: 0, bTex: [null, null], bFbo: [null, null] };
  function makeColorTarget(w, h) {
    gl.activeTexture(gl.TEXTURE0 + 15); // scratch unit so real bindings are not clobbered
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }
  function freeTargets() {
    if (rt.sceneTex) { gl.deleteTexture(rt.sceneTex); gl.deleteRenderbuffer(rt.depth); gl.deleteFramebuffer(rt.sceneFbo); }
    for (let i = 0; i < 2; i++) if (rt.bTex[i]) { gl.deleteTexture(rt.bTex[i]); gl.deleteFramebuffer(rt.bFbo[i]); }
    rt.sceneTex = null;
  }
  let needsResize = true;
  function resize() {
    needsResize = false;
    const dpr = opt.dpr || Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.floor((canvas.clientWidth || canvas.width || 640) * dpr));
    const ch = Math.max(1, Math.floor((canvas.clientHeight || canvas.height || 360) * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const sw = Math.max(1, Math.round(cw * opt.renderScale)), sh = Math.max(1, Math.round(ch * opt.renderScale));
    if (sw === rt.w && sh === rt.h && rt.sceneTex) return;
    freeTargets();
    rt.w = sw; rt.h = sh;
    const c = makeColorTarget(sw, sh);
    rt.sceneTex = c.tex; rt.sceneFbo = c.fbo;
    rt.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rt.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, sw, sh);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rt.depth);
    rt.bw = Math.max(1, sw >> 2); rt.bh = Math.max(1, sh >> 2);
    for (let i = 0; i < 2; i++) { const b = makeColorTarget(rt.bw, rt.bh); rt.bTex[i] = b.tex; rt.bFbo[i] = b.fbo; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { needsResize = true; }); ro.observe(canvas); }

  // palette LUT (3D) built lazily
  let lutTex = null;
  function ensureLut() {
    if (lutTex) return;
    const data = buildPaletteLut(pal, 32);
    lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + U_LUT);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 32, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }
  if (opt.classic) ensureLut();

  // ---------------------------------------------------------------- camera / entities / lights state (nothing here allocates per frame)
  const camA = { x: 0, y: 0, z: 41, angle: 0, pitch: 0, fov: opt.fov }, camB = { x: 0, y: 0, z: 41, angle: 0, pitch: 0, fov: opt.fov }, camI = { x: 0, y: 0, z: 41, angle: 0, pitch: 0, fov: opt.fov };
  let camPrev = camA, camCur = camB;
  function setCamera(c) {
    const older = camPrev, prev = camCur;
    older.x = c.x ?? prev.x; older.y = c.y ?? prev.y; older.z = c.z ?? prev.z; older.angle = c.angle ?? prev.angle; older.pitch = c.pitch ?? prev.pitch; older.fov = c.fov ?? prev.fov;
    camPrev = prev; camCur = older;
    if (c.teleport) { prev.x = older.x; prev.y = older.y; prev.z = older.z; prev.angle = older.angle; prev.pitch = older.pitch; prev.fov = older.fov; }
  }
  const entPrev = new Map();
  let entCur = [];
  function setEntities(list) {
    entPrev.clear();
    for (let i = 0; i < entCur.length; i++) entPrev.set(entCur[i].id ?? i, entCur[i]);
    entCur = list || [];
  }
  const lightArr = [], lightById = new Map();
  let lightSeq = 1;
  function addLight(l) {
    const id = lightSeq++;
    const o = { id, x: l.x, y: l.y, z: l.z ?? 40, radius: l.radius ?? 200, color: parseColor(l.color), intensity: l.intensity ?? 1, ttl: l.ttl ?? null, age: 0 };
    lightArr.push(o); lightById.set(id, o);
    return id;
  }
  function removeLight(id) {
    const o = lightById.get(id);
    if (!o) return;
    lightById.delete(id);
    const i = lightArr.indexOf(o);
    if (i >= 0) { lightArr[i] = lightArr[lightArr.length - 1]; lightArr.pop(); }
  }
  function updateLight(id, patch) {
    const l = lightById.get(id);
    if (!l) return;
    if (patch.color !== undefined) l.color = parseColor(patch.color);
    for (const k of ['x', 'y', 'z', 'radius', 'intensity']) if (patch[k] !== undefined) l[k] = patch[k];
  }

  // ---------------------------------------------------------------- live sector heights
  function setSectorHeights(floors, ceils) {
    const n = Math.min(nsec, floors ? floors.length : 0);
    for (let s = 0; s < n; s++) {
      const f = floors[s], c = ceils[s];
      if (f !== liveF[s]) { liveF[s] = f; deltaArr[s * 2] = f - baseF[s]; deltaDirty = zDirty = true; }
      if (c !== liveC[s]) { liveC[s] = c; deltaArr[s * 2 + 1] = c - baseC[s]; deltaDirty = zDirty = true; }
    }
  }
  function uploadDeltas() {
    deltaDirty = false;
    gl.activeTexture(gl.TEXTURE0 + U_DELTA);
    gl.bindTexture(gl.TEXTURE_2D, deltaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, slotRows, gl.RED, gl.FLOAT, deltaArr);
  }
  // live z extent of each sector's geometry = base extent shifted by the delta of the slot each vertex follows
  function recomputeZ() {
    zDirty = false;
    let glo = 1e9, ghi = -1e9;
    const zs = geo.zStart, zd = geo.zData;
    for (let s = 0; s < nsec; s++) {
      let lo = 1e9, hi = -1e9;
      for (let e = zs[s]; e < zs[s + 1]; e++) {
        const b = zd[e * 3], d = b >= 0 ? deltaArr[b] : 0;
        if (zd[e * 3 + 1] + d < lo) lo = zd[e * 3 + 1] + d;
        if (zd[e * 3 + 2] + d > hi) hi = zd[e * 3 + 2] + d;
      }
      if (lo > hi) { lo = 0; hi = 0; }
      secZLo[s] = lo - 1; secZHi[s] = hi + 1;
      if (lo < glo) glo = lo; if (hi > ghi) ghi = hi;
    }
    zLo = glo - 1; zHi = ghi + 1;
  }
  recomputeZ();

  // ---------------------------------------------------------------- per-frame scratch
  const P = new Float32Array(16), V = new Float32Array(16), VP = new Float32Array(16);
  const planes = new Float32Array(24);
  const lpArr = new Float32Array(16 * 4), lcArr = new Float32Array(16 * 4);
  const selLight = new Array(16).fill(null), selScore = new Float32Array(16);
  let nLights = 0;
  let curAnimTic = -1, time = 0;
  const stat = { drawCalls: 0, triangles: 0, cpuMs: 0, gpuMs: null, visibleSectors: 0, visibleSubsectors: 0, sprites: 0, syncMs: null, renderSize: [0, 0] };
  const QN = 4, qPool = [], qBusy = new Uint8Array(QN);
  if (timerExt) for (let i = 0; i < QN; i++) qPool.push(gl.createQuery());
  let lastGpuMs = null, qHead = 0, qTail = 0, qCount = 0, qActive = -1;

  // camera frame used by the BSP walk / sprite code
  let camX = 0, camY = 0, fwdX = 1, fwdY = 0, rgtX = 0, rgtY = -1, colMid = 0, colScale = 0, occlOn = false;
  const COLS = 512, NEAR = 0.5;
  const cover = new Uint32Array(COLS >> 5);
  const order = new Int32Array(geo.nUnits + 1), stamp = new Int32Array(geo.nUnits + 1), secSeen = new Int32Array(nsec);
  let orderN = 0, stampN = 0, allCovered = false, ssVisited = 0;
  const stackC = new Int32Array(2048), stackB = new Int32Array(2048);

  function buildMatrices(cam, aspect) {
    const a = cam.angle, p = cam.pitch;
    const cp = Math.cos(p), sp = Math.sin(p);
    const fx = Math.cos(a) * cp, fy = Math.sin(a) * cp, fz = sp;
    const rx = Math.sin(a), ry = -Math.cos(a), rz = 0;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    // column-major view matrix rows (r, u, -f)
    V[0] = rx; V[4] = ry; V[8] = rz; V[12] = -(rx * cam.x + ry * cam.y + rz * cam.z);
    V[1] = ux; V[5] = uy; V[9] = uz; V[13] = -(ux * cam.x + uy * cam.y + uz * cam.z);
    V[2] = -fx; V[6] = -fy; V[10] = -fz; V[14] = (fx * cam.x + fy * cam.y + fz * cam.z);
    V[3] = 0; V[7] = 0; V[11] = 0; V[15] = 1;
    // horizontal FOV is specified for a 4:3 view; vertical derived with the pixel stretch, then hor+ for wider windows
    const tanV = Math.tan((cam.fov * Math.PI / 180) / 2) / ((4 / 3) * opt.pixelStretch);
    const f = 1 / tanV, near = 1, far = 12000;
    P.fill(0);
    P[0] = f / aspect; P[5] = f; P[10] = (far + near) / (near - far); P[11] = -1; P[14] = 2 * far * near / (near - far);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += P[k * 4 + r] * V[c * 4 + k];
      VP[c * 4 + r] = s;
    }
    // frustum planes r3 +/- r_i (left, right, bottom, top, near, far)
    for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) {
      planes[(2 * i) * 4 + k] = VP[k * 4 + 3] + VP[k * 4 + i];
      planes[(2 * i + 1) * 4 + k] = VP[k * 4 + 3] - VP[k * 4 + i];
    }
    camX = cam.x; camY = cam.y; fwdX = Math.cos(a); fwdY = Math.sin(a); rgtX = rx; rgtY = ry;
    // Azimuth -> column mapping used for 1-D occlusion. T is the widest horizontal tangent of the (pitched) frustum, so every
    // visible ray maps inside [0, COLS); when looking so steeply that the frustum reaches the zenith the occluder is switched off.
    const den = cp - tanV * Math.abs(sp);
    occlOn = den > 0.08 && !opt.noOcclusion;
    if (occlOn) { colMid = COLS * 0.5; colScale = COLS * 0.5 * den / (tanV * aspect); }
  }

  // ---- 1-D column coverage (Doom's solidsegs, as a bitset)
  function rangeCovered(a, b) {
    for (let w = a >> 5, we = b >> 5; w <= we; w++) {
      let m = 0xffffffff;
      if (w === (a >> 5)) m = (m << (a & 31)) >>> 0;
      if (w === we) m = (m & (0xffffffff >>> (31 - (b & 31)))) >>> 0;
      if (((cover[w] & m) >>> 0) !== m) return false;
    }
    return true;
  }
  function markCovered(a, b) {
    for (let w = a >> 5, we = b >> 5; w <= we; w++) {
      let m = 0xffffffff;
      if (w === (a >> 5)) m = (m << (a & 31)) >>> 0;
      if (w === we) m = (m & (0xffffffff >>> (31 - (b & 31)))) >>> 0;
      cover[w] = (cover[w] | m) >>> 0;
    }
    allCovered = true;
    for (let w = 0; w < cover.length; w++) if (cover[w] !== 0xffffffff) { allCovered = false; break; }
  }
  let spLo = 0, spHi = 0;
  // column span of a wall segment; false when it is behind the camera
  function segSpan(x1, y1, x2, y2) {
    let f1 = (x1 - camX) * fwdX + (y1 - camY) * fwdY, r1 = (x1 - camX) * rgtX + (y1 - camY) * rgtY;
    let f2 = (x2 - camX) * fwdX + (y2 - camY) * fwdY, r2 = (x2 - camX) * rgtX + (y2 - camY) * rgtY;
    if (f1 < NEAR && f2 < NEAR) return false;
    if (f1 < NEAR) { const t = (NEAR - f1) / (f2 - f1); r1 += (r2 - r1) * t; f1 = NEAR; }
    else if (f2 < NEAR) { const t = (NEAR - f2) / (f1 - f2); r2 += (r1 - r2) * t; f2 = NEAR; }
    const c1 = colMid + colScale * r1 / f1, c2 = colMid + colScale * r2 / f2;
    if (c1 < c2) { spLo = c1; spHi = c2; } else { spLo = c2; spHi = c1; }
    return spHi >= 0 && spLo <= COLS;
  }
  function frustumBox(x0, y0, x1, y1, z0, z1) {
    for (let i = 0; i < 6; i++) {
      const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
      if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
    }
    return true;
  }
  let cLo = 0, cHi = 0, cBehind = 0;
  function corner(x, y) {
    const f = (x - camX) * fwdX + (y - camY) * fwdY;
    if (f < NEAR) { cBehind++; return; }
    const c = colMid + colScale * ((x - camX) * rgtX + (y - camY) * rgtY) / f;
    if (c < cLo) cLo = c; if (c > cHi) cHi = c;
  }
  // can any part of this xy box (z range z0..z1) be visible?
  function boxVisible(x0, y0, x1, y1, z0, z1) {
    if (!frustumBox(x0, y0, x1, y1, z0, z1)) return false;
    if (!occlOn || (camX >= x0 && camX <= x1 && camY >= y0 && camY <= y1)) return true;
    cLo = 1e9; cHi = -1e9; cBehind = 0;
    corner(x0, y0); corner(x1, y0); corner(x1, y1); corner(x0, y1);
    if (cBehind === 4) return false;
    if (cBehind > 0) return true;
    const a = Math.max(0, Math.floor(cLo)), b = Math.min(COLS - 1, Math.floor(cHi));
    return a > b || !rangeCovered(a, b);
  }
  function visitSubsector(ss) {
    const s = geo.ssSector[ss];
    if (s < 0) return;
    const o = ss * 4, sb = geo.ssBox;
    if (!frustumBox(sb[o], sb[o + 1], sb[o + 2], sb[o + 3], secZLo[s], secZHi[s])) return;
    ssVisited++; secSeen[s] = stampN;
    order[orderN++] = NL * 2 + ss;                                     // its floor + ceiling polygons
    const sub = subs[ss];
    for (let k = 0; k < sub.count; k++) {
      const sg = sub.first + k, unit = sgUnit[sg];
      if (unit < 0) continue;
      const x1 = sgX1[sg], y1 = sgY1[sg], x2 = sgX2[sg], y2 = sgY2[sg];
      if ((x2 - x1) * (camY - y1) - (y2 - y1) * (camX - x1) >= 0) continue;   // back-facing (front side is on the right of v1->v2)
      let hidden = false;
      if (occlOn) {
        if (!segSpan(x1, y1, x2, y2)) continue;
        const a = Math.max(0, Math.floor(spLo)), b = Math.min(COLS - 1, Math.floor(spHi));
        if (a > b || rangeCovered(a, b)) continue;
      }
      if (stamp[unit] !== stampN) { stamp[unit] = stampN; order[orderN++] = unit; }
      if (occlOn && !hidden) {
        const li = sgLd[sg], fs = ldFs[li], bs = ldBs[li];
        if (bs < 0 || fs < 0 || Math.min(liveC[fs], liveC[bs]) <= Math.max(liveF[fs], liveF[bs])) {   // one-sided wall or closed door/lift: solid
          const a = Math.max(0, Math.ceil(spLo)), b = Math.min(COLS - 1, Math.ceil(spHi) - 1);
          if (a <= b) markCovered(a, b);
        }
      }
    }
  }
  // front-to-back BSP walk: fills `order` with draw units (subsector flats + visible linedef sides)
  function bspWalk() {
    orderN = 0; ssVisited = 0; stampN++;
    cover.fill(0); allCovered = false;
    if (!haveBsp) { for (let u = 0; u < geo.nUnits; u++) order[orderN++] = u; for (let s = 0; s < nsec; s++) secSeen[s] = stampN; return; }
    let sp = 0;
    stackC[0] = nodes.length ? nodes.length - 1 : 0x8000; stackB[0] = -1; sp = 1;
    while (sp > 0 && !allCovered) {
      const c = stackC[--sp], b = stackB[sp];
      if (b >= 0) { const o = b * 4; if (!boxVisible(nodeBox[o], nodeBox[o + 1], nodeBox[o + 2], nodeBox[o + 3], zLo, zHi)) continue; }
      if (c & 0x8000) { visitSubsector(c === 0xffff ? 0 : c & 0x7fff); continue; }
      const nd = nodes[c];
      const side = (nd.dx * (camY - nd.y) - nd.dy * (camX - nd.x)) < 0 ? 0 : 1;   // 0: camera is on the right child's side
      stackC[sp] = side ? nd.right : nd.left; stackB[sp++] = c * 2 + (side ? 0 : 1);   // far side first ...
      stackC[sp] = side ? nd.left : nd.right; stackB[sp++] = c * 2 + (side ? 1 : 0);   // ... so the near side is popped (and clipped against) first
    }
    let seen = 0; for (let s = 0; s < nsec; s++) if (secSeen[s] === stampN) seen++;
    stat.visibleSectors = seen;
  }

  function buildIndexLists() {
    let tris = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi], src = b.data.indices, ranges = b.data.ranges, dst = b.frame;
      let n = 0;
      for (let o = 0; o < orderN; o++) {
        const u = order[o], st = ranges[u * 2], ct = ranges[u * 2 + 1];
        for (let k = 0; k < ct; k++) dst[n + k] = src[st + k];
        n += ct;
      }
      b.count = n;
      if (n) {
        gl.bindVertexArray(b.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibo);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, dst, 0, n);
      }
      tris += n / 3;
    }
    return tris;
  }

  // ---- sprites -> sprData
  let sprN = 0;
  function pushSprite(spr, x, y, z, light, fb, mask) {
    if (sprN >= MAX_SPRITES) return;
    const dx = x - camX, dy = y - camY, depth = dx * fwdX + dy * fwdY;
    if (depth < -spr.w || depth > 6000) return;                          // behind the camera / too far
    const l = -spr.left, r = spr.w - spr.left, zt = z + spr.top, zb = zt - spr.h;
    const d = sprData, o = sprN * 4 * SPR_FLOATS;
    for (let k = 0; k < 4; k++) {
      const q = o + k * SPR_FLOATS, side = (k === 0 || k === 3) ? l : r, top = k >= 2;
      d[q] = x + rgtX * side; d[q + 1] = y + rgtY * side; d[q + 2] = top ? zt : zb;
      d[q + 3] = (k === 0 || k === 3) ? spr.u0 : spr.u1; d[q + 4] = top ? spr.v0 : spr.v1; d[q + 5] = light; d[q + 6] = fb; d[q + 7] = mask;
    }
    sprN++;
  }
  const rotNames = new Map();
  function rotatedName(name, rot) {
    let arr = rotNames.get(name);
    if (!arr) { arr = []; for (let i = 0; i < 8; i++) arr.push(name.slice(0, 5) + (i + 1)); rotNames.set(name, arr); }
    return arr[rot];
  }
  function buildSprites(cam, alpha) {
    sprN = 0;
    for (let i = 0; i < staticThings.length; i++) {
      const t = staticThings[i];
      if (haveBsp && secSeen[t.sec] !== stampN) continue;
      pushSprite(t.spr, t.x, t.y, t.z, secLight[t.sec * 2], t.fb, secMask[t.sec]);
    }
    for (let i = 0; i < entCur.length; i++) {
      const e = entCur[i];
      let x = e.x, y = e.y, z = e.z ?? 0, ang = e.angle ?? 0;
      if (alpha !== undefined && alpha < 1) {
        const p = entPrev.get(e.id ?? i);
        if (p && !e.teleport) { x = lerp(p.x, e.x, alpha); y = lerp(p.y, e.y, alpha); z = lerp(p.z ?? 0, e.z ?? 0, alpha); ang = lerpAngle(p.angle ?? 0, e.angle ?? 0, alpha); }
      }
      let name = e.sprite;
      if (!name) continue;
      if (name.length >= 6 && e.rotate !== false && e.angle !== undefined && name.charCodeAt(5) === 49) {
        const toThing = Math.atan2(y - cam.y, x - cam.x);
        let rot = Math.floor((toThing - ang + Math.PI * 9 / 8) / (Math.PI / 4));
        rot = ((rot % 8) + 8) % 8;
        const rn = rotatedName(name, rot);
        if (getSprite(rn)) name = rn;
      }
      const spr = getSprite(name);
      if (!spr) continue;
      const sec = pointInSector(map, x, y);
      pushSprite(spr, x, y, z, sec >= 0 ? secLight[sec * 2] : 160, e.fullbright ? 1 : 0, sec >= 0 ? secMask[sec] : 0);
    }
    return sprN;
  }

  function setLightUniforms(prog, cam) {
    const u = prog.u;
    gl.uniform3f(u.uCam, cam.x, cam.y, cam.z);
    gl.uniform1i(u.uNL, nLights);
    gl.uniform4fv(u.uLP, lpArr);
    gl.uniform4fv(u.uLC, lcArr);
    gl.uniform1f(u.uAmbient, opt.ambient);
    gl.uniform1f(u.uFogDensity, opt.fogDensity);
    gl.uniform3fv(u.uFogColor, opt.fogColor);
    gl.uniform1f(u.uClassic, opt.classic ? 1 : 0);
    gl.uniform1f(u.uLightGain, opt.lightGain);
  }

  function collectLights(dt, cam) {
    const K = Math.min(16, opt.maxLights);
    let n = 0;
    for (let i = 0; i < lightArr.length; i++) {
      const l = lightArr[i];
      if (l.ttl !== null) {
        l.age += dt;
        if (l.age >= l.ttl) { lightById.delete(l.id); lightArr[i] = lightArr[lightArr.length - 1]; lightArr.pop(); i--; continue; }
      }
      const score = Math.hypot(l.x - cam.x, l.y - cam.y) - l.radius;
      if (n < K || score < selScore[n - 1]) {
        let j = n < K ? n++ : K - 1;
        while (j > 0 && selScore[j - 1] > score) { selScore[j] = selScore[j - 1]; selLight[j] = selLight[j - 1]; j--; }
        selScore[j] = score; selLight[j] = l;
      }
    }
    nLights = n;
    for (let i = 0; i < n; i++) {
      const l = selLight[i], fade = l.ttl !== null ? 1 - l.age / l.ttl : 1, k = l.intensity * fade;
      lpArr[i * 4] = l.x; lpArr[i * 4 + 1] = l.y; lpArr[i * 4 + 2] = l.z; lpArr[i * 4 + 3] = l.radius;
      lcArr[i * 4] = l.color[0] * k; lcArr[i * 4 + 1] = l.color[1] * k; lcArr[i * 4 + 2] = l.color[2] * k;
    }
  }
  // Which sectors can each light reach? Flood from the light's sector across portals that are open (live heights) and within its radius,
  // so light never bleeds through solid walls or closed doors. Result: per-sector bitmask (bit i = light slot i).
  const bfsQ = new Int32Array(nsec + 1), bfsStamp = new Int32Array(nsec);
  let bfsN = 0;
  function computeLightMasks() {
    secMask.fill(0);
    for (let i = 0; i < nLights; i++) {
      const l = selLight[i], bit = 1 << i, st = ++bfsN, r2 = l.radius * l.radius;
      const s0 = pointInSector(map, l.x, l.y);
      if (s0 < 0) { for (let s = 0; s < nsec; s++) secMask[s] |= bit; continue; }
      let qh = 0, qt = 0;
      bfsQ[qt++] = s0; bfsStamp[s0] = st; secMask[s0] |= bit;
      while (qh < qt) {
        const s = bfsQ[qh++];
        for (let k = adjStart[s], ke = adjStart[s + 1]; k < ke; k++) {
          const nb = adjNb[k];
          if (bfsStamp[nb] === st) continue;
          if (Math.min(liveC[s], liveC[nb]) <= Math.max(liveF[s], liveF[nb])) continue;   // closed door / no opening
          const li = adjLd[k], ax = ldAx[li], ay = ldAy[li], dx = ldBx[li] - ax, dy = ldBy[li] - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((l.x - ax) * dx + (l.y - ay) * dy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + dx * t - l.x, ey = ay + dy * t - l.y;
          if (ex * ex + ey * ey >= r2) continue;
          bfsStamp[nb] = st; secMask[nb] |= bit; bfsQ[qt++] = nb;
        }
      }
    }
  }

  function pollQueries() {
    while (qCount > 0) {
      const i = qHead, q = qPool[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) lastGpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      qBusy[i] = 0; qHead = (qHead + 1) % QN; qCount--;
    }
  }

  function bindTex(prog, name, unit) { if (prog.u[name] !== undefined && prog.u[name] !== null) gl.uniform1i(prog.u[name], unit); }

  function render(dt = 0, alpha) {
    const t0 = performance.now();
    if (needsResize || !rt.sceneTex) resize();
    time += dt;

    // interpolated camera
    let cam = camCur;
    if (alpha !== undefined && alpha < 1) {
      camI.x = lerp(camPrev.x, camCur.x, alpha); camI.y = lerp(camPrev.y, camCur.y, alpha); camI.z = lerp(camPrev.z, camCur.z, alpha);
      camI.angle = lerpAngle(camPrev.angle, camCur.angle, alpha); camI.pitch = lerp(camPrev.pitch, camCur.pitch, alpha); camI.fov = lerp(camPrev.fov, camCur.fov, alpha);
      cam = camI;
    }

    if (opt.animate) {
      const tic = Math.floor(time * 35 / 8);
      if (tic !== curAnimTic) { curAnimTic = tic; setAnimFrame(wallInfo, tic); setAnimFrame(flatInfo, tic); }
    }
    if (deltaDirty) uploadDeltas();
    if (zDirty) recomputeZ();
    updateSectorLight(time);
    collectLights(dt, cam);
    computeLightMasks();
    uploadSectorLight();

    buildMatrices(cam, rt.w / rt.h);
    bspWalk();
    stat.visibleSubsectors = ssVisited;
    let tris = buildIndexLists();

    let qi = -1;
    if (timerExt) { pollQueries(); if (qCount < QN) { qi = (qHead + qCount) % QN; gl.beginQuery(timerExt.TIME_ELAPSED_EXT, qPool[qi]); } }

    // ---- scene pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.sceneFbo);
    gl.viewport(0, 0, rt.w, rt.h);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.clearColor(0.02, 0.02, 0.04, 1); gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindSampler(U_SCENE, null);
    let calls = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi];
      if (!b.count) continue;
      const pr = b.prog;
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, VP);
      bindTex(pr, 'uDelta', U_DELTA);
      if (b.kind === 'sky') {
        gl.uniform3f(pr.u.uCam, cam.x, cam.y, cam.z);
        bindTex(pr, 'uSky', U_SKY);
        gl.uniform2f(pr.u.uSkySize, skyPic.w, skyPic.h);
        gl.uniform1f(pr.u.uClipZ, opt.clipZ);
      } else {
        setLightUniforms(pr, cam);
        const flat = b.kind === 'flat';
        bindTex(pr, 'uTex', flat ? U_FLAT : U_WALL);
        bindTex(pr, 'uInfo', flat ? U_FINFO : U_WINFO);
        bindTex(pr, 'uSecLight', U_SECL);
        gl.uniform1f(pr.u.uLodBias, opt.lodBias);
        gl.uniform1f(pr.u.uClipZ, opt.clipZ);
      }
      gl.bindVertexArray(b.vao);
      gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
      calls++;
    }
    // sprites
    const ns = buildSprites(cam, alpha);
    stat.sprites = ns;
    if (ns) {
      gl.useProgram(progSpr.p);
      gl.uniformMatrix4fv(progSpr.u.uVP, false, VP);
      setLightUniforms(progSpr, cam);
      bindTex(progSpr, 'uAtlas', U_ATLAS);
      gl.bindVertexArray(sprVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, sprVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sprData, 0, ns * 4 * SPR_FLOATS);
      gl.drawElements(gl.TRIANGLES, ns * 6, gl.UNSIGNED_SHORT, 0);
      calls++; tris += ns * 2;
    }

    // ---- bloom
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(emptyVao);
    const useBloom = opt.bloom && opt.bloomStrength > 0;
    gl.bindSampler(U_SCENE, sLinear);
    gl.activeTexture(gl.TEXTURE0 + U_SCENE);
    gl.bindTexture(gl.TEXTURE_2D, rt.sceneTex);
    if (useBloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.bFbo[0]);
      gl.viewport(0, 0, rt.bw, rt.bh);
      gl.useProgram(progBright.p);
      gl.uniform1i(progBright.u.uSrc, U_SCENE);
      gl.uniform2f(progBright.u.uTexel, 1 / rt.w, 1 / rt.h);
      gl.uniform1f(progBright.u.uThreshold, opt.bloomThreshold);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindSampler(U_SCENE, sLinear);
      for (let pass = 0; pass < 2; pass++) {
        gl.useProgram(progBlur.p);
        gl.uniform1i(progBlur.u.uSrc, U_SCENE);
        // horizontal: bloom0 -> bloom1
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt.bFbo[1]);
        gl.bindTexture(gl.TEXTURE_2D, rt.bTex[0]);
        gl.uniform2f(progBlur.u.uDir, 1 / rt.bw, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt.bFbo[0]);
        gl.bindTexture(gl.TEXTURE_2D, rt.bTex[1]);
        gl.uniform2f(progBlur.u.uDir, 0, 1 / rt.bh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      calls += 5;
    }

    // ---- composite to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(progComp.p);
    gl.activeTexture(gl.TEXTURE0 + U_SCENE);
    gl.bindTexture(gl.TEXTURE_2D, rt.sceneTex);
    gl.bindSampler(U_SCENE, opt.renderScale > 1 ? sLinear : sNearest);
    gl.activeTexture(gl.TEXTURE0 + U_BLOOM);
    gl.bindTexture(gl.TEXTURE_2D, rt.bTex[0]);
    gl.bindSampler(U_BLOOM, sLinear);
    if (opt.classic) ensureLut();
    gl.uniform1i(progComp.u.uScene, U_SCENE);
    gl.uniform1i(progComp.u.uBloom, U_BLOOM);
    gl.uniform1i(progComp.u.uLut, U_LUT);
    gl.uniform1f(progComp.u.uBloomStrength, useBloom ? opt.bloomStrength : 0);
    gl.uniform1f(progComp.u.uClassic, opt.classic ? 1 : 0);
    gl.uniform1f(progComp.u.uGamma, opt.gamma);
    gl.uniform1f(progComp.u.uVignette, opt.vignette);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    calls++;
    gl.bindSampler(U_BLOOM, null);
    gl.bindSampler(U_SCENE, null);

    if (qi >= 0) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); qBusy[qi] = 1; qCount++; }
    stat.cpuMs = performance.now() - t0;
    if (opt.syncTiming) {
      const s0 = performance.now();
      gl.finish();
      stat.syncMs = performance.now() - s0 + stat.cpuMs;
    }
    stat.gpuMs = lastGpuMs;
    stat.drawCalls = calls; stat.triangles = Math.round(tris);
    stat.renderSize[0] = rt.w; stat.renderSize[1] = rt.h;
  }

  function setOptions(patch) {
    const oldScale = opt.renderScale;
    Object.assign(opt, patch);
    if (opt.renderScale !== oldScale) needsResize = true;
    if (opt.classic) ensureLut();
  }

  function setRenderScale(sc) { setOptions({ renderScale: Math.max(0.1, Math.min(4, +sc || 1)) }); }

  function dispose() {
    if (ro) ro.disconnect();
    for (const q of qPool) gl.deleteQuery(q);
    freeTargets();
    for (const p of programs) gl.deleteProgram(p.p);
    for (const b of batches) { gl.deleteBuffer(b.vbo); gl.deleteBuffer(b.ibo); gl.deleteVertexArray(b.vao); }
    for (const t of [wallTex, flatTex, wallInfo.tex, flatInfo.tex, secLightTex, deltaTex, skyTex, atlas, lutTex]) if (t) gl.deleteTexture(t);
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }

  resize();
  updateSectorLight(0);
  uploadSectorLight();

  return {
    setCamera, addLight, removeLight, updateLight, setEntities, render, resize, setOptions, setSectorHeights, setRenderScale,
    stats: () => stat, dispose, _dbg: (q = []) => ({ ssinfo: q.map((i) => ({ i, box: Array.from(geo.ssBox.subarray(i * 4, i * 4 + 4)), sec: geo.ssSector[i], z: [secZLo[geo.ssSector[i]], secZHi[geo.ssSector[i]]], segs: subs[i], })), order: Array.from(order.subarray(0, orderN)), NL, nodes: nodes.length, zLo, zHi, planes: Array.from(planes), camX, camY, occlOn }),
    options: opt, gl,
    info: () => ({ wallTextures: wallReg.entries.length, flats: flatReg.entries.length, staticSprites: staticThings.length, wallLayerSize: wallS, sky: skyName, bsp: haveBsp, dynamicSectors: geo.dynamic.reduce((a, b) => a + b, 0), geometry: { wall: geo.batches.wall.triangles, masked: geo.batches.masked.triangles, flat: geo.batches.flat.triangles, sky: geo.batches.sky.triangles } }),
  };
}

/*
 * Options (all optional): renderScale, dpr, fov, pixelStretch, bloom, bloomStrength, bloomThreshold, classic,
 * fogDensity, fogColor, ambient, lightGain, gamma, vignette, lodBias, things, animate, sectorEffects, sky,
 * maxLights, preserveDrawingBuffer, syncTiming. Most can be changed at runtime with setOptions().
 * Extras on the returned object: updateLight(id, patch), setOptions(patch), setRenderScale(s), setSectorHeights(floors, ceils), info().
 * setSectorHeights(floors, ceils): live sector heights from the sim (world.sectorFloor / sectorCeil, GameClient.sectorHeights());
 * cheap enough to call every frame - only changed sectors touch a small float texture, no geometry is rebuilt.
 * render(dt, alpha): when alpha in [0,1) is given, camera and entities are interpolated between the previous and
 * the latest setCamera()/setEntities() call (fixed-tick gameplay + display-rate rendering).
 */
