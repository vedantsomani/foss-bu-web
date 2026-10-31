// hud.js - DOM HUD. Text is only written when a value changes (no layout churn in the frame loop).
import { WEAPONS } from '../game/weapons.js';

const $ = id => document.getElementById(id);
const fmtTime = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export class Hud {
  constructor() {
    this.root = $('hud'); this.c = Object.create(null);
    this.el = { hp: $('hp'), hpBar: $('hpBar'), ar: $('ar'), ammo: $('ammo'), wname: $('wname'), timer: $('timer'), frags: $('myFrags'), lead: $('lead'), center: $('center'),
      feed: $('feed'), toast: $('toast'), fps: $('fps'), score: $('score'), scoreBody: $('scoreBody'), scoreTitle: $('scoreTitle'), pain: $('pain'), hitm: $('hitm') };
    this.slots = WEAPONS.map((w, i) => { const d = document.createElement('div'); d.textContent = i + 1; $('wslots').appendChild(d); return d; });
    this.dmg = [...$('dmg').children].map(el => ({ el, ang: 0, t: 0 }));
    this.pain = 0; this.painShown = 0; this.hitAnim = null;
  }
  show(v) { this.root.hidden = !v; }
  txt(key, el, v) { if (this.c[key] !== v) { this.c[key] = v; el.textContent = v; } }
  cls(key, el, name, on) { if (this.c[key] !== on) { this.c[key] = on; el.classList.toggle(name, on); } }
  // me: local state; timeLeft seconds; lead: text. Numbers are compared before any string is built (no per-frame garbage).
  update(me, timeLeft, bestId, best, nameOf) {
    const e = this.el, c = this.c;
    if (c.hpN !== me.health || c.alv !== me.alive) {
      c.hpN = me.health; c.alv = me.alive;
      const hp = Math.max(0, me.health); e.hp.textContent = hp; e.hp.classList.toggle('low', me.alive && hp <= 25);
      const w = Math.min(100, hp); e.hpBar.style.transform = `scaleX(${w / 100})`; e.hpBar.style.background = w > 50 ? '#ff7a2f' : w > 25 ? '#ffb02f' : '#ff5b4b';
    }
    if (c.arN !== me.armor) { c.arN = me.armor; e.ar.textContent = me.armor; }
    if (c.wN !== me.weapon) { c.wN = me.weapon; e.wname.textContent = WEAPONS[me.weapon].name; }
    const ammo = me.ammo[WEAPONS[me.weapon].ammoType]; if (c.amN !== ammo) { c.amN = ammo; e.ammo.textContent = ammo; }
    for (let i = 0; i < this.slots.length; i++) {
      const o = (me.owned >> i) & 1, cur = me.weapon === i, dry = o && me.ammo[WEAPONS[i].ammoType] < WEAPONS[i].cost;
      const k = (o ? 1 : 0) | (cur ? 2 : 0) | (dry ? 4 : 0);
      if (c['s' + i] !== k) { c['s' + i] = k; this.slots[i].className = (o ? 'own ' : '') + (cur ? 'cur ' : '') + (dry ? 'dry' : ''); }
    }
    if (c.frN !== me.frags) { c.frN = me.frags; e.frags.textContent = me.frags; }
    const ts = Math.max(0, Math.ceil(timeLeft)); if (c.tsN !== ts) { c.tsN = ts; e.timer.textContent = fmtTime(ts); }
    if (c.bId !== bestId || c.bN !== best) { c.bId = bestId; c.bN = best; e.lead.textContent = nameOf(bestId) + ' ' + best; }
  }
  frame(dt, yaw) {
    if (this.pain > 0) {
      this.pain = Math.max(0, this.pain - dt * 1.6);
      if (Math.abs(this.pain - this.painShown) > 0.01 || this.pain === 0) { this.painShown = this.pain; this.el.pain.style.opacity = this.pain.toFixed(2); }
    }
    for (const d of this.dmg) {
      if (d.t <= 0) continue;
      d.t -= dt;
      if (d.t <= 0) { d.el.style.opacity = 0; continue; }
      d.el.style.opacity = Math.min(1, d.t / 0.6);
      d.el.style.transform = `rotate(${(-(d.ang - yaw)).toFixed(3)}rad)`;
    }
  }
  damage(worldAngle, amount) {
    this.pain = Math.min(0.9, this.pain + 0.25 + amount / 70);
    if (worldAngle === null) return;
    let s = this.dmg[0]; for (const d of this.dmg) if (d.t < s.t) s = d;
    s.ang = worldAngle; s.t = 1.6;
  }
  hit(kill) {
    const h = this.el.hitm; h.classList.toggle('kill', kill);
    if (this.hitAnim) this.hitAnim.cancel();
    this.hitAnim = h.animate([{ opacity: 1, transform: 'scale(1.25)' }, { opacity: 0, transform: 'scale(.9)' }], { duration: kill ? 520 : 260, easing: 'ease-out' });
  }
  feed(killer, weapon, victim, mine) {
    const f = this.el.feed, d = document.createElement('div');
    if (mine) d.className = 'me';
    const em = Object.assign(document.createElement('em'), { textContent: killer ? weapon : 'died' });
    if (killer) d.append(killer, em, victim); else d.append(victim, em);
    f.appendChild(d); while (f.children.length > 5) f.firstChild.remove();
    setTimeout(() => d.remove(), 6000);
  }
  toast(text) {
    const t = this.el.toast; t.textContent = text;
    t.animate([{ opacity: 0, transform: 'translate(-50%,8px)' }, { opacity: 1, transform: 'translate(-50%,0)', offset: 0.1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1600 });
  }
  center(text, sub = '') {
    if (this.c.ct === text && this.c.cs === sub) return; this.c.ct = text; this.c.cs = sub;
    this.el.center.textContent = text; if (sub) { const s = document.createElement('small'); s.textContent = sub; this.el.center.appendChild(s); }
  }
  fps(text) { this.txt('fps', this.el.fps, text); }
  scoreboard(visible, rows, title) {
    this.el.score.hidden = !visible; if (!visible) return;
    this.el.scoreTitle.textContent = title;
    const b = this.el.scoreBody; b.textContent = '';
    for (const r of rows) {
      const tr = document.createElement('tr'); if (r.me) tr.className = 'me';
      for (const v of [r.name, r.frags, r.deaths]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
      b.appendChild(tr);
    }
  }
}
