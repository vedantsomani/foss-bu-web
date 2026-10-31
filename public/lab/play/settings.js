// settings.js - persisted per-viewer settings (localStorage is a convenience only; every access is guarded).
const KEY = 'fragline.play.settings.v1';
export const DEFAULTS = { sens: 2.5, invertY: false, fov: 90, volume: 0.7, quality: 'balanced', fpsCap: 0, showFps: true, dynRes: true, name: 'Player' };
// renderScale is the *maximum* scale; dynamic resolution may go lower.
export const QUALITY = {
  performance: { renderScale: 0.6, bloom: false, maxLights: 6, dpr: 1, classic: false },
  balanced: { renderScale: 0.85, bloom: true, maxLights: 10, dpr: 1.5, classic: false },
  ultra: { renderScale: 1, bloom: true, maxLights: 16, dpr: 2, classic: false },
};
export function loadSettings() {
  const s = { ...DEFAULTS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode etc. */ }
  return s;
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }
