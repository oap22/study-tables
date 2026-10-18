// Charts drawn by hand as SVG/HTML strings, so the site keeps no build step and
// no chart library. Each builder returns markup; bindCharts() wires hover and
// tap tooltips once that markup is in the page.
//
// Encoding used everywhere: Present = ink, Absent = MSOE red, Excused = gray
// with a hatch. Lightness differs between all three, and Absent/Excused also
// carry a letter or hatch, so color is never the only cue.

import { shortDate, parseISO } from './dates.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pctText = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const md = (iso) => { const d = parseISO(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const r1 = (n) => Math.round(n * 10) / 10;

// Point data for the trend charts on the page, read back by bindCharts().
const registry = new Map();
let nextId = 0;

// Hatch used for Excused fills. Every SVG that uses it defines its own copy.
const hatchDef = (id) => `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <rect width="5" height="5" class="fill-e"/><line x1="0" y1="0" x2="0" y2="5" class="hatch-line"/></pattern>`;

// A bar segment with a 4px rounded end on the right, square at the baseline.
function barPath(x, y, w, h, round) {
  if (w <= 0) return '';
  const r = round ? Math.min(4, w, h / 2) : 0;
  return `M${r1(x)},${r1(y)}h${r1(w - r)}${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''}v${r1(h - 2 * r)}${r ? `a${r},${r} 0 0 1 ${-r},${r}` : ''}h${r1(-(w - r))}z`;
}

// Clean tick step for a percent axis spanning `span` (0..1).
function tickStep(span) {
  if (span <= 0.3) return 0.05;
  if (span <= 0.6) return 0.1;
  return 0.25;
}

// ---------- Team attendance by session (line) ----------
// points: [{ date, pct, present, absent, excused }], oldest first.
export function trendChart(points, { threshold, width }) {
  const pts = points.filter((p) => p.pct !== null);
  if (!pts.length) return `<p class="empty small">The trend shows up after the first session is logged.</p>`;

  const W = Math.round(width), H = 210;
  const m = { l: 40, r: 40, t: 14, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const minVal = Math.min(threshold, ...pts.map((p) => p.pct));
  const step = tickStep(1 - minVal + 0.05);
  const lo = Math.max(0, Math.floor((minVal - 0.05) / step) * step);
  const y = (v) => m.t + ih - ((v - lo) / (1 - lo)) * ih;
  const x = (i) => m.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);

  const ticks = [];
  for (let v = lo; v <= 1.0001; v += step) ticks.push(Math.round(v * 100) / 100);
  const grid = ticks.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${r1(y(v))}" y2="${r1(y(v))}"/>
    <text class="tick" x="${m.l - 8}" y="${r1(y(v)) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');

  // Date labels: as many as fit at ~44px each, always the first and last.
  const every = Math.max(1, Math.ceil(pts.length / Math.max(1, Math.floor(iw / 44))));
  const xLabels = pts.map((p, i) => (i % every === 0 || i === pts.length - 1) && !(i !== pts.length - 1 && pts.length - 1 - i < every)
    ? `<text class="tick" x="${r1(x(i))}" y="${H - 6}" text-anchor="middle">${md(p.date)}</text>` : '').join('');

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(x(i))},${r1(y(p.pct))}`).join('');
  const area = `${line}L${r1(x(pts.length - 1))},${m.t + ih}L${r1(x(0))},${m.t + ih}Z`;
  const ty = r1(y(threshold));
  const last = pts.at(-1);

  const id = `trend-${nextId++}`;
  registry.set(id, { pts: pts.map((p, i) => ({ ...p, cx: x(i), cy: y(p.pct) })), threshold });

  return `<div class="viz" data-chart="trend" data-id="${id}">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Team attendance by session, ${pts.length} sessions. Latest ${pctText(last.pct)}.">
      ${grid}
      <line class="threshold" x1="${m.l}" x2="${W - m.r}" y1="${ty}" y2="${ty}"/>
      <text class="threshold-label" x="${m.l + 4}" y="${ty - 5}">FLAG ${Math.round(threshold * 100)}%</text>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" hidden/>
      ${pts.map((p, i) => `<circle class="dot ${p.pct < threshold ? 'low' : ''}" cx="${r1(x(i))}" cy="${r1(y(p.pct))}" r="4"/>`).join('')}
      <text class="end-label" x="${r1(x(pts.length - 1)) + 8}" y="${r1(y(last.pct)) + 4}">${pctText(last.pct)}</text>
      ${xLabels}
      <rect class="hit" x="${m.l - 12}" y="0" width="${iw + 24}" height="${H}" tabindex="0" aria-label="Move along the trend with the arrow keys"/>
    </svg></div>`;
}

// ---------- Per-player breakdown (stacked bars) ----------
// players: stats rows with { name, active, present, excused, absent, pct }.
export function playerBars(players, { threshold, width }) {
  const rows = players
    .filter((p) => p.present + p.absent + p.excused > 0)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.present - a.present || a.name.localeCompare(b.name));
  if (!rows.length) return `<p class="empty small">No marks yet.</p>`;

  const W = Math.round(width), rowH = 30, barH = 16;
  const nameW = 76, pctW = 52;
  const iw = W - nameW - pctW;
  const max = Math.max(...rows.map((p) => p.present + p.absent + p.excused));
  const H = rows.length * rowH + 4;
  const hatch = `hatch-${nextId++}`;

  const body = rows.map((p, i) => {
    const y0 = i * rowH + (rowH - barH) / 2;
    const segs = [['P', p.present, 'fill-p'], ['E', p.excused, 'fill-e-hatch'], ['A', p.absent, 'fill-a']].filter((s) => s[1] > 0);
    let xPos = nameW;
    const paths = segs.map(([, n, cls], j) => {
      const w = (n / max) * iw;
      const gap = j < segs.length - 1 ? 2 : 0; // 2px surface gap between touching segments
      const d = barPath(xPos, y0, w - gap, barH, j === segs.length - 1);
      xPos += w;
      return `<path class="${cls}" d="${d}" ${cls === 'fill-e-hatch' ? `fill="url(#${hatch})"` : ''}/>`;
    }).join('');
    const flagged = p.pct !== null && p.pct < threshold;
    const tip = `${p.name}${p.active ? '' : ' (off roster)'}|${pctText(p.pct)}|${p.present} present · ${p.absent} absent · ${p.excused} excused`;
    return `<g class="row ${p.active ? '' : 'inactive'}" data-tip="${esc(tip)}" tabindex="0">
      <rect class="hit-row" x="0" y="${i * rowH}" width="${W}" height="${rowH}"/>
      <text class="row-name" x="0" y="${r1(y0 + barH / 2 + 4.5)}">${esc(p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name)}</text>
      ${paths}
      ${flagged ? `<path class="flag-mark" d="M${W - pctW + 8},${r1(y0 + 2)}l9,6l-9,6z"/>` : ''}
      <text class="row-pct ${flagged ? 'flagged' : ''}" x="${W}" y="${r1(y0 + barH / 2 + 4.5)}" text-anchor="end">${pctText(p.pct)}</text>
    </g>`;
  }).join('');

  return `<div class="viz" data-chart="tips">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Present, excused and absent sessions for each player, highest attendance first.">
      <defs>${hatchDef(hatch)}</defs>${body}
    </svg></div>`;
}

// ---------- Player x session grid ----------
// sessions: sessionSeries() rows; players: [{ name, active }].
export function attendanceGrid(sessions, players) {
  if (!sessions.length) return `<p class="empty small">The grid fills in as sessions are logged.</p>`;
  const rows = players.filter((p) => p.active || sessions.some((s) => s.marks[p.name]));
  const glyph = { P: '', A: 'A', E: 'E' };
  const word = { P: 'Present', A: 'Absent', E: 'Excused' };

  let lastMonth = -1;
  const head = sessions.map((s) => {
    const d = parseISO(s.date);
    const showMonth = d.getMonth() !== lastMonth;
    lastMonth = d.getMonth();
    return `<div class="gh${showMonth ? ' new-month' : ''}" title="${shortDate(s.date)}">
      <span class="gh-m">${showMonth ? d.toLocaleString('en-US', { month: 'short' }) : ''}</span><span class="gh-d">${d.getDate()}</span></div>`;
  }).join('');

  const body = rows.map((p) => `<div class="gn${p.active ? '' : ' inactive'}">${esc(p.name)}</div>` + sessions.map((s) => {
    const mk = s.marks[p.name];
    const tip = `${p.name}|${mk ? word[mk] : 'Not marked'}|${shortDate(s.date)}`;
    return `<div class="gc" data-mark="${mk ?? ''}" data-tip="${esc(tip)}" tabindex="-1">${mk ? glyph[mk] : ''}</div>`;
  }).join('')).join('');

  return `<div class="grid-scroll" data-chart="tips">
    <div class="att-grid" style="--cols:${sessions.length}" role="img" aria-label="Attendance grid: one row per player, one column per session. The table below has the same totals.">
      <div class="gn gn-head"></div>${head}${body}
    </div></div>`;
}

// ---------- Small pieces ----------
// Horizontal stacked bar of one session's marks, sized to the roster.
export function tallyBar({ P = 0, A = 0, E = 0, U = 0 }) {
  const seg = (n, cls, label) => (n ? `<span class="seg ${cls}" style="flex:${n}" title="${n} ${label}"></span>` : '');
  return `<div class="tally-bar" aria-hidden="true">${seg(P, 'fill-p', 'present')}${seg(E, 'fill-e-hatch', 'excused')}${seg(A, 'fill-a', 'absent')}${seg(U, 'fill-u', 'unmarked')}</div>`;
}

// A meter of `value` (0..1) with a tick at the flag threshold.
export function meter(value, threshold) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  return `<div class="meter" aria-hidden="true">
    <span class="meter-fill${value !== null && value < threshold ? ' low' : ''}" style="width:${(v * 100).toFixed(1)}%"></span>
    <span class="meter-flag" style="left:${(threshold * 100).toFixed(1)}%"></span>
  </div>`;
}

// ---------- Tooltip ----------
let tip;
function tooltip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'status');
  tip.hidden = true;
  tip.append(document.createElement('strong'), document.createElement('span'), document.createElement('small'));
  document.body.append(tip);
  const hide = () => (tip.hidden = true);
  window.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-tip], [data-chart="trend"]')) hide(); });
  return tip;
}

// Text goes in with textContent only: player names and notes are user data.
function showTip(title, value, detail, clientX, clientY) {
  const t = tooltip();
  const [a, b, c] = t.children;
  a.textContent = value;
  b.textContent = title;
  c.textContent = detail;
  t.hidden = false;
  const { width, height } = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, clientX - width / 2));
  const top = clientY - height - 14 < 8 ? clientY + 18 : clientY - height - 14;
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
export function hideTip() { if (tip) tip.hidden = true; }

export function bindCharts(root) {
  hideTip();
  root.querySelectorAll('[data-chart="tips"]').forEach((el) => {
    const show = (target, cx, cy) => {
      const [title, value, detail] = target.dataset.tip.split('|');
      target.classList.add('is-hot');
      showTip(title, value, detail, cx, cy);
    };
    const clear = (target) => target?.classList.remove('is-hot');
    let hot = null;
    const move = (e) => {
      const t = e.target.closest('[data-tip]');
      if (t !== hot) { clear(hot); hot = t; }
      if (t) show(t, e.clientX, e.clientY);
      else hideTip();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    // A finger lifting counts as leaving; keep the tip up until the next tap or scroll.
    el.addEventListener('pointerleave', (e) => { clear(hot); hot = null; if (e.pointerType !== 'touch') hideTip(); });
    el.addEventListener('focusin', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) return;
      const r = t.getBoundingClientRect();
      show(t, r.left + r.width / 2, r.top);
    });
    el.addEventListener('focusout', (e) => { clear(e.target.closest('[data-tip]')); hideTip(); });
  });

  root.querySelectorAll('[data-chart="trend"]').forEach((el) => {
    const data = registry.get(el.dataset.id);
    if (!data) return;
    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.crosshair');
    const dots = svg.querySelectorAll('.dot');
    const hit = svg.querySelector('.hit');
    let current = data.pts.length - 1;
    const select = (i) => {
      current = i;
      const p = data.pts[i];
      cross.hidden = false;
      cross.setAttribute('x1', p.cx);
      cross.setAttribute('x2', p.cx);
      dots.forEach((d, j) => d.classList.toggle('is-hot', j === i));
      const box = svg.getBoundingClientRect();
      showTip(shortDate(p.date), pctText(p.pct), `${p.present} present · ${p.absent} absent · ${p.excused} excused`,
        box.left + p.cx, box.top + p.cy);
    };
    const clear = () => { cross.hidden = true; dots.forEach((d) => d.classList.remove('is-hot')); hideTip(); };
    const nearest = (clientX) => {
      const x = clientX - svg.getBoundingClientRect().left;
      let best = 0;
      data.pts.forEach((p, i) => { if (Math.abs(p.cx - x) < Math.abs(data.pts[best].cx - x)) best = i; });
      return best;
    };
    hit.addEventListener('pointermove', (e) => select(nearest(e.clientX)));
    hit.addEventListener('pointerdown', (e) => select(nearest(e.clientX)));
    hit.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && clear());
    hit.addEventListener('focus', () => select(current));
    hit.addEventListener('blur', clear);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        select(Math.max(0, Math.min(data.pts.length - 1, current + (e.key === 'ArrowLeft' ? -1 : 1))));
      }
    });
  });

  // Keep the newest sessions in view on the grid.
  root.querySelectorAll('.grid-scroll').forEach((el) => (el.scrollLeft = el.scrollWidth));
}

// Forget point data for charts that are no longer on the page.
export function resetCharts() {
  registry.clear();
}
