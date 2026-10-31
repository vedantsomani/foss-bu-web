// statusbar.js - the vanilla Doom status bar (STBAR + STT/STY/STG numbers, STARMS, STKEYS, the STF* marine face) drawn on a 2D canvas
// in Doom's 320x200 virtual space, plus the face behaviour of st_stuff.c (idle look, pain level, ouch, turn toward the attacker,
// evil grin on a weapon pickup, rampage face after holding fire, dead face).
export const BAR_H = 32, VIRT_W = 320, VIRT_H = 200;
const TIC = 1 / 35;

// Layout in virtual units (st_stuff.c)
const L = { ammoX: 44, ammoY: 171, healthX: 90, healthY: 171, armorX: 221, armorY: 171, armsBgX: 104, armsBgY: 168, armsX: 111, armsY: 172, armsDX: 12, armsDY: 10,
  faceX: 143, faceY: 168, keyX: 239, keyY: [171, 181, 191], ammoRowX: 288, ammoMaxX: 314, ammoRowY: [173, 179, 185, 191] };

export class Face {
  constructor() { this.name = 'STFST01'; this.holdUntil = 0; this.prio = 0; this.nextIdle = 0; this.look = 1; this.fireSince = -1; this.lastHealth = 100; this.lastOwned = 1; }
  // dmg: health lost; rel: attacker bearing relative to my view in radians (>0 = to my left), or null for self / unknown
  hurt(now, dmg, rel) {
    if (this.prio > 8) return;
    this.prio = 7; this.holdUntil = now + 35 * TIC; this.kind = 'ouch';
    if (dmg > 20 || rel === null) this.kind = 'ouch';
    else if (Math.abs(rel) < Math.PI / 4) this.kind = 'kill';
    else this.kind = rel > 0 ? 'tl' : 'tr';
  }
  grin(now) { if (this.prio > 8) return; this.prio = 8; this.holdUntil = now + 2 * 1 + 0; this.kind = 'evl'; }
  // me: local player state, firing: fire button held
  update(me, now, firing) {
    const pain = Math.min(4, Math.floor((100 - Math.max(0, Math.min(100, me.health))) * 5 / 101));
    if (!me.alive) { this.name = 'STFDEAD0'; this.prio = 9; return this.name; }
    if (this.prio === 9) { this.prio = 0; this.holdUntil = 0; }
    if (me.spawnProt > 0 && me.health >= 100 && false) { this.name = 'STFGOD0'; return this.name; }
    if (now >= this.holdUntil) this.prio = 0;
    // rampage: fire held for 2 seconds
    if (firing) { if (this.fireSince < 0) this.fireSince = now; else if (now - this.fireSince > 2 && this.prio < 6) { this.prio = 6; this.holdUntil = now + 0.1; this.kind = 'kill'; } } else this.fireSince = -1;
    this.lastHealth = me.health;
    if (this.prio > 0) {
      const k = this.kind;
      this.name = k === 'ouch' ? 'STFOUCH' + pain : k === 'evl' ? 'STFEVL' + pain : k === 'kill' ? 'STFKILL' + pain : k === 'tl' ? 'STFTL' + pain + '0' : 'STFTR' + pain + '0';
      if (k === 'tl' || k === 'tr') this.name = (k === 'tl' ? 'STFTL' : 'STFTR') + pain + '0';
      return this.name;
    }
    if (now >= this.nextIdle) { this.nextIdle = now + 17 * TIC; this.look = (Math.random() * 3) | 0; }   // random glance every 17 tics
    this.name = 'STFST' + pain + this.look;
    return this.name;
  }
}

// g: 2D context already transformed to Doom virtual space. me: local player state. keys: bitmask of keys 1..6 (optional)
export function drawStatusBar(g, gfx, me, face, ammoMax, opts = {}) {
  const bar = gfx.pic('STBAR'); if (!bar) return false;
  g.drawImage(bar.canvas, 0, VIRT_H - BAR_H);
  const Y = VIRT_H - BAR_H;   // = 168
  // arms box (STARMS) and the six slots 2..7 (owned = yellow, otherwise grey)
  gfx.draw(g, 'STARMS', L.armsBgX, L.armsBgY);
  const own = opts.slotOwned || [];
  for (let i = 0; i < 6; i++) {
    const x = L.armsX + (i % 3) * L.armsDX, y = L.armsY + ((i / 3) | 0) * L.armsDY, slot = i + 2;
    gfx.draw(g, (own[slot] ? 'STYSNUM' : 'STGNUM') + slot, x, y);
  }
  if (opts.ammo !== undefined && opts.ammo >= 0) gfx.number(g, opts.ammo, L.ammoX, L.ammoY, 'STTNUM', 1, false);
  gfx.number(g, Math.max(0, me.health), L.healthX, L.healthY, 'STTNUM', 1, true);
  gfx.number(g, me.armor, L.armorX, L.armorY, 'STTNUM', 1, true);
  // face (with the player-colour backdrop in netgames, STFB0)
  gfx.draw(g, 'STFB0', L.faceX, 169);
  gfx.draw(g, face.name, L.faceX, L.faceY);
  // keys: slot i shows STKEYS{i} (card) / STKEYS{i+3} (skull); a key mask has bits 0..5
  const keys = opts.keys | 0;
  for (let row = 0; row < 3; row++) { const k = (keys >> row) & 1 ? row : (keys >> (row + 3)) & 1 ? row + 3 : -1; if (k >= 0) gfx.draw(g, 'STKEYS' + k, L.keyX, L.keyY[row]); }
  // ammo table: bullets, shells, rockets, cells
  for (let i = 0; i < 4; i++) {
    gfx.number(g, me.ammo[i], L.ammoRowX, L.ammoRowY[i], 'STYSNUM', 1, false);
    gfx.number(g, ammoMax[i], L.ammoMaxX, L.ammoRowY[i], 'STYSNUM', 1, false);
  }
  return true;
}

// the bar background across the full window width: the centre 4:3 part is the real lump, the sides repeat its outermost columns
export function drawBarSides(ctx, gfx, W, H, sx, sy, ox) {
  const bar = gfx.pic('STBAR'); if (!bar) return;
  const y = (VIRT_H - BAR_H) * sy, h = BAR_H * sy;
  if (ox > 0) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bar.canvas, 0, 0, 1, BAR_H, 0, y, ox + 1, h);
    ctx.drawImage(bar.canvas, bar.w - 1, 0, 1, BAR_H, ox + VIRT_W * sx - 1, y, W - (ox + VIRT_W * sx) + 1, h);
  }
}
