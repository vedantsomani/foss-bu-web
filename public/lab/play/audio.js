// audio.js - WebAudio mixer for Doom DMX sound lumps. Local sounds are plain; world sounds go through HRTF/equal-power panners.
// DMX lump: u16 format(3), u16 rate, u32 samples, then 16 pad bytes + 8-bit unsigned PCM + 16 pad bytes.
const SOUNDS = ['BAREXP', 'PISTOL', 'SHOTGN', 'DSHTGN', 'SGCOCK', 'RLAUNC', 'RXPLOD', 'FIRSHT', 'FIRXPL', 'PLASMA', 'BFG', 'PLPAIN', 'PLDETH', 'PDIEHI',
  'ITEMUP', 'WPNUP', 'GETPOW', 'ITMBK', 'OOF', 'JUMP', 'TELEPT', 'TINK', 'OUCH', 'NOWAY', 'DOROPN', 'DORCLS', 'SWTCHN', 'SWTCHX', 'STNMOV', 'SLOP', 'PSTART', 'PSTOP'];
const SCALE = 1 / 32;           // doom units -> audio "metres"
const MAX_VOICES = 28, MAX_HRTF = 8, CULL = 2800;

export function decodeDmx(bytes) {
  if (bytes.length < 40) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== 3) return null;
  const rate = v.getUint16(2, true) || 11025, n = Math.min(v.getUint32(4, true), bytes.length - 8);
  const len = n - 32; if (len <= 0) return null;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (bytes[8 + 16 + i] - 128) / 128;
  return { rate, data: out };
}

export class GameAudio {
  constructor() { this.ctx = null; this.buffers = {}; this.voices = 0; this.hrtf = 0; this.volume = 0.7; this.ready = false; this.lastPlay = {}; }
  // unlock() must be called from a user gesture (creates + resumes the context); load(wad) can follow later
  unlock() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.resume();
  }
  load(wad) {
    const ctx = this.ctx; if (!ctx || this.ready) return;
    for (const n of SOUNDS) {
      const lump = wad.lump('DS' + n); if (!lump) continue;
      const d = decodeDmx(lump); if (!d) continue;
      // resample to the context rate with linear interpolation + a tiny low-pass so 11 kHz sources do not sound crunchy
      const sr = ctx.sampleRate, outLen = Math.max(1, Math.floor(d.data.length * sr / d.rate)), buf = ctx.createBuffer(1, outLen, sr), ch = buf.getChannelData(0);
      const k = d.rate / sr; let prev = 0;
      for (let i = 0; i < outLen; i++) {
        const f = i * k, a = Math.floor(f), t = f - a, s0 = d.data[a] || 0, s1 = d.data[a + 1] || s0;
        const s = s0 + (s1 - s0) * t; prev += (s - prev) * 0.7; ch[i] = prev;
      }
      this.buffers[n] = buf;
    }
    this.ready = true;
  }
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  // listener pose in doom coordinates (z up); audio axes: x=x, y=z, z=-y
  setListener(x, y, z, yaw, pitch) {
    const L = this.ctx && this.ctx.listener; if (!L) return;
    const cp = Math.cos(pitch);
    if (L.positionX) {
      L.positionX.value = x * SCALE; L.positionY.value = z * SCALE; L.positionZ.value = -y * SCALE;
      L.forwardX.value = Math.cos(yaw) * cp; L.forwardY.value = Math.sin(pitch); L.forwardZ.value = -Math.sin(yaw) * cp;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(x * SCALE, z * SCALE, -y * SCALE); L.setOrientation(Math.cos(yaw) * cp, Math.sin(pitch), -Math.sin(yaw) * cp, 0, 1, 0); }
    this.lx = x; this.ly = y; this.lz = z;
  }
  // name: sound id without "DS". opts: x,y,z (world position, omit for local), vol, rate (playbackRate), jitter
  play(name, x, y, z, vol = 1, rate = 1) {
    if (!this.ready || this.ctx.state !== 'running') return;
    const buf = this.buffers[name]; if (!buf || this.voices >= MAX_VOICES) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (this.lastPlay[name] > now - 0.025) return;        // collapse identical sounds triggered in the same instant
    this.lastPlay[name] = now;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
    const g = ctx.createGain(); g.gain.value = vol; src.connect(g);
    let panner = null;
    if (x !== undefined) {
      const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
      if (dx * dx + dy * dy + dz * dz > CULL * CULL) return;
      panner = ctx.createPanner();
      const hr = this.hrtf < MAX_HRTF; panner.panningModel = hr ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse'; panner.refDistance = 8; panner.rolloffFactor = 1.3; panner.maxDistance = 200;
      if (panner.positionX) { panner.positionX.value = x * SCALE; panner.positionY.value = z * SCALE; panner.positionZ.value = -y * SCALE; }
      else panner.setPosition(x * SCALE, z * SCALE, -y * SCALE);
      g.connect(panner); panner.connect(this.master);
      if (hr) { this.hrtf++; src.onended = () => { this.hrtf--; this.voices--; panner.disconnect(); g.disconnect(); }; }
      else src.onended = () => { this.voices--; panner.disconnect(); g.disconnect(); };
    } else {
      g.connect(this.master);
      src.onended = () => { this.voices--; g.disconnect(); };
    }
    this.voices++;
    src.start();
  }
}
