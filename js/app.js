import { DATA_REPO } from './config.js';
import { GitHubBackend, MemoryBackend, SeasonSync, ConflictError } from './store.js';
import { computeStats, formatPct, toCSV, sessionSummary, allPlayers } from './stats.js';
import { todayISO, longDate, shortDate, navigableDates, nextSessionDate, missedDates, DAY_NAMES, isLogged } from './dates.js';
import { newSeason, hasRecords } from './model.js';

// ---------- Device storage (edit key and view preferences only) ----------
const KEY = 'studyTables.key';
const SEASON_PREF = 'studyTables.season';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ?demo on localhost runs against the sample data in memory; nothing is saved.
const params = new URLSearchParams(location.search);
const DEMO = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('demo');
const today = () => (DEMO && params.get('today')) || todayISO();

const state = {
  backend: null,
  index: null,
  seasonName: null,
  sync: null,
  tab: 'take',
  date: null,
  canEdit: false,
  keyRejected: false,
  sort: { key: 'rank', dir: 1 },
};

const $view = document.getElementById('view');
const $status = document.getElementById('save-status');
const $picker = document.getElementById('season-picker');
const seasonPath = (name) => `seasons/${name}.json`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MARK_LABEL = { P: 'Present', A: 'Absent', E: 'Excused' };
const NEXT_MARK = { undefined: 'P', P: 'A', A: 'E', E: 'P' };

// ---------- Boot ----------
async function boot() {
  const tabFromHash = location.hash.slice(1);
  if (['take', 'stats', 'history', 'settings'].includes(tabFromHash)) state.tab = tabFromHash;

  if (DEMO) {
    const sample = await (await fetch('test/fixtures/sample-season.json')).json();
    state.backend = new MemoryBackend({ 'index.json': { current: 'sample', seasons: ['sample'] }, 'seasons/sample.json': sample });
  } else {
    state.backend = new GitHubBackend(DATA_REPO, store.get(KEY));
  }

  wireChrome();
  try {
    state.index = (await state.backend.read('index.json')).data;
    if (!state.index) throw new Error('No data found: data/index.json is missing.');
    const saved = store.get(SEASON_PREF);
    await openSeason(state.index.seasons.includes(saved) ? saved : state.index.current);
  } catch (e) {
    $view.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
  }
  await checkKey();
}

async function checkKey() {
  const had = !!state.backend.token;
  state.canEdit = had && (await state.backend.canWrite().catch(() => false));
  state.keyRejected = had && !state.canEdit;
  render();
}

async function openSeason(name) {
  if (state.sync?.pending.length) await state.sync.flush();
  state.seasonName = name;
  state.sync = new SeasonSync(state.backend, seasonPath(name), onSyncChange);
  await state.sync.load();
  state.date = null;
  renderPicker();
  render();
}

function onSyncChange(dataChanged) {
  renderStatus();
  if (!dataChanged) return;
  // Don't rebuild the page under someone who is typing.
  const el = document.activeElement;
  if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) renderView();
}

function wireChrome() {
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      history.replaceState(null, '', `#${state.tab}`);
      render();
      window.scrollTo(0, 0);
    }),
  );
  window.addEventListener('hashchange', () => {
    const tab = location.hash.slice(1);
    if (['take', 'stats', 'history', 'settings'].includes(tab) && tab !== state.tab) { state.tab = tab; render(); }
  });
  $picker.addEventListener('change', () => {
    store.set(SEASON_PREF, $picker.value);
    openSeason($picker.value).catch((e) => alert(e.message));
  });
  $status.addEventListener('click', () => {
    if (state.sync?.status === 'error') state.sync.flush();
  });
  window.addEventListener('online', () => state.sync?.pending.length && state.sync.flush());
  window.addEventListener('beforeunload', (e) => {
    if (state.sync?.pending.length) e.preventDefault();
  });
  // Pick up edits made on other devices when coming back to the page.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.sync || state.sync.pending.length) return;
    try { await state.sync.load(); } catch { /* keep what we have */ }
  });
}

// ---------- Render ----------
function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  renderStatus();
  renderView();
}

function renderPicker() {
  const seasons = state.index?.seasons ?? [];
  $picker.innerHTML = seasons
    .slice()
    .reverse()
    .map((s) => `<option value="${esc(s)}" ${s === state.seasonName ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  $picker.hidden = seasons.length < 2;
}

function renderStatus() {
  const s = state.sync?.status;
  let text = 'Saved', st = 'saved';
  if (!state.canEdit) { text = DEMO ? 'Demo' : 'View only'; st = 'readonly'; }
  if (s === 'pending' || s === 'saving') { text = 'Saving…'; st = 'saving'; }
  if (s === 'error') { text = 'Not saved · retry'; st = 'error'; }
  $status.textContent = text;
  $status.dataset.state = st;
  $status.title = state.sync?.error?.message ?? '';
}

function renderView() {
  const season = state.sync?.view;
  if (!season) return;
  const views = { take: viewTake, stats: viewStats, history: viewHistory, settings: viewSettings };
  views[state.tab](season);
}

// ---------- Attendance ----------
function viewTake(season) {
  const t = today();
  const dates = navigableDates(season, t);
  const next = nextSessionDate(season, t);
  if (!state.date) state.date = next ?? dates.filter((d) => d <= t).at(-1) ?? dates[0] ?? null;
  if (!state.date) {
    const why = season.schedule?.days?.length ? 'No sessions fall in the scheduled dates.' : 'No meeting days are set for this season.';
    $view.innerHTML = `<div class="notice">${why} Fix the schedule in <button class="linklike" data-go="settings">Settings</button>.</div>`;
    bindGo();
    return;
  }
  if (!dates.includes(state.date)) dates.push(state.date), dates.sort();

  const date = state.date;
  const i = dates.indexOf(date);
  const session = season.sessions?.[date] ?? { canceled: false, note: '', marks: {} };
  const marks = session.marks || {};
  const players = allPlayers(season).filter((p) => p.active || marks[p.name]);
  const counts = { P: 0, A: 0, E: 0 };
  players.forEach((p) => marks[p.name] && counts[marks[p.name]]++);
  const unmarked = players.filter((p) => !marks[p.name]).length;

  const tags = [];
  if (date === t) tags.push('Today');
  if (date === next && date !== t) tags.push('Next session');
  else if (date > t && date !== next) tags.push('Upcoming');
  if (date < t) tags.push('Past session');
  if (session.canceled) tags.push('Canceled');

  const missed = state.canEdit ? missedDates(season, t) : [];
  const edit = state.canEdit;

  $view.innerHTML = `
    ${!edit ? `<div class="notice">View only. ${state.keyRejected ? 'The saved edit key no longer works.' : 'Add the edit key'} in <button class="linklike" data-go="settings">Settings</button> to take attendance.</div>` : ''}
    ${missed.length ? `<div class="notice warn">${missed.length} past session${missed.length > 1 ? 's' : ''} not logged or canceled. <button class="linklike" data-date="${missed[0]}">Open ${shortDate(missed[0])}</button></div>` : ''}
    <div class="${session.canceled ? 'canceled' : ''}">
      <div class="session-nav">
        <button type="button" data-date="${dates[i - 1] ?? ''}" ${i > 0 ? '' : 'disabled'} aria-label="Previous session">‹</button>
        <div class="session-date">
          <h2>${longDate(date)}</h2>
          <span class="session-tag">${tags.join(' · ')}</span>
        </div>
        <button type="button" data-date="${dates[i + 1] ?? ''}" ${i < dates.length - 1 ? '' : 'disabled'} aria-label="Next session">›</button>
      </div>
      ${session.canceled ? `<div class="notice">This session is canceled and left out of every stat.</div>` : ''}
      <div class="tally" aria-label="Session totals">
        <div><span class="num">${counts.P}</span><span class="lbl">Present</span></div>
        <div><span class="num">${counts.A}</span><span class="lbl">Absent</span></div>
        <div><span class="num">${counts.E}</span><span class="lbl">Excused</span></div>
        <div><span class="num">${unmarked}</span><span class="lbl">Unmarked</span></div>
      </div>
      ${edit ? `
      <div class="session-actions">
        <button type="button" class="btn dark" id="all-present" ${unmarked && !session.canceled ? '' : 'disabled'}>${unmarked === players.length ? 'All present' : `Rest present (${unmarked})`}</button>
        <button type="button" class="btn" id="toggle-cancel">${session.canceled ? 'Restore session' : 'Cancel session'}</button>
      </div>
      <p class="hint">Tap a name to switch: Present → Absent → Excused</p>` : ''}
      <ul class="roster">
        ${players.map((p) => {
          const m = marks[p.name];
          return `<li><button type="button" class="player" data-name="${esc(p.name)}" data-mark="${m ?? ''}" ${edit && !session.canceled ? '' : 'disabled'}
            aria-label="${esc(p.name)}: ${m ? MARK_LABEL[m] : 'not marked'}">
            <span>${esc(p.name)}</span><span class="pill" data-mark="${m ?? ''}">${m ? MARK_LABEL[m] : edit ? 'Tap to mark' : '—'}</span></button></li>`;
        }).join('')}
      </ul>
    </div>
    ${edit ? `
      <label class="field-label" for="note">Note (optional)</label>
      <input type="text" id="note" value="${esc(session.note ?? '')}" placeholder="e.g. Moved to library room 2" maxlength="200">
      <p class="small"><button type="button" class="linklike" id="clear-marks" ${Object.keys(marks).length ? '' : 'hidden'}>Clear all marks for this date</button></p>
    ` : session.note ? `<p class="sc-note">${esc(session.note)}</p>` : ''}
  `;

  $view.querySelectorAll('[data-date]').forEach((b) =>
    b.addEventListener('click', () => { if (b.dataset.date) { state.date = b.dataset.date; renderView(); } }),
  );
  bindGo();
  if (!edit) return;

  $view.querySelectorAll('.player').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.name;
      const value = NEXT_MARK[marks[name]];
      state.sync.queue({ t: 'mark', date, name, value });
      renderView();
    }),
  );
  $view.querySelector('#all-present').addEventListener('click', () => {
    const fill = Object.fromEntries(players.filter((p) => !marks[p.name]).map((p) => [p.name, 'P']));
    state.sync.queue({ t: 'marks', date, marks: fill });
    renderView();
  });
  $view.querySelector('#toggle-cancel').addEventListener('click', () => {
    state.sync.queue({ t: 'session', date, canceled: !session.canceled });
    renderView();
  });
  $view.querySelector('#note').addEventListener('change', (e) => {
    state.sync.queue({ t: 'session', date, note: e.target.value.trim() });
  });
  $view.querySelector('#clear-marks').addEventListener('click', () => {
    if (!confirm(`Clear every mark for ${shortDate(date)}?`)) return;
    state.sync.queue({ t: 'marks', date, marks: Object.fromEntries(Object.keys(marks).map((n) => [n, null])) });
    renderView();
  });
}

function bindGo() {
  $view.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.go; history.replaceState(null, '', `#${state.tab}`); render(); }),
  );
}

// ---------- Stats ----------
function namesList(players, detail = () => '') {
  if (!players.length) return `<div class="hl-names none">No one yet</div>`;
  return `<div class="hl-names">${players.map((p) => esc(p.name) + detail(p)).join(', ')}</div>`;
}

function viewStats(season) {
  const { highlights: h, players } = computeStats(season);
  const thr = Math.round(h.threshold * 100);
  const hl = (title, value, body, flag = false) =>
    `<div class="hl ${flag ? 'flag' : ''}"><span class="hl-title">${title}</span>${value != null ? `<span class="hl-value">${value}</span>` : ''}${body}</div>`;

  const cols = [
    ['name', 'Player'], ['present', 'P'], ['absent', 'A'], ['excused', 'E'],
    ['pct', 'Att %'], ['rank', 'Rank'], ['streak', 'Streak'], ['lastAbsence', 'Last absence'],
  ];
  const { key, dir } = state.sort;
  const sorted = players.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va === vb) return a.name.localeCompare(b.name);
    if (va === null) return 1; // blanks always last
    if (vb === null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });

  $view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span class="num">${h.sessionsLogged}</span><span class="lbl">Sessions logged</span></div>
      <div class="kpi dark"><span class="num">${formatPct(h.teamPct)}</span><span class="lbl">Team attendance</span></div>
    </div>
    <div class="highlights">
      ${hl('Most sessions attended', h.mostAttended.value, namesList(h.mostAttended.players))}
      ${hl('Highest attendance', h.highestPct.value != null ? formatPct(h.highestPct.value) : null, namesList(h.highestPct.players))}
      ${hl('Perfect attendance', null, namesList(h.perfect))}
      ${hl('Most absences', h.mostAbsences.value, namesList(h.mostAbsences.players, (p) => ` (${formatPct(p.pct)})`))}
      ${hl('Longest current streak', h.longestStreak.value, namesList(h.longestStreak.players))}
      ${hl(`Under ${thr}%`, null, namesList(h.underThreshold, (p) => ` ${formatPct(p.pct)}`), h.underThreshold.length > 0)}
    </div>

    <h3 class="section-title">Players</h3>
    <div class="table-wrap">
      <table>
        <thead><tr>${cols.map(([k, label]) =>
          `<th aria-sort="${k === key ? (dir === 1 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}">${label}</button></th>`).join('')}</tr></thead>
        <tbody>${sorted.map((p) => `
          <tr class="${p.active ? '' : 'inactive'}">
            <td>${esc(p.name)}${p.active ? '' : '<span class="tag">off roster</span>'}</td>
            <td>${p.present}</td><td>${p.absent}</td><td>${p.excused}</td>
            <td class="${p.pct !== null && p.pct < h.threshold ? 'flagged' : ''}">${formatPct(p.pct)}</td>
            <td>${p.rank ?? '—'}</td><td>${p.streak}</td>
            <td>${p.lastAbsence ? shortDate(p.lastAbsence) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="small muted">Attendance % = Present ÷ (Present + Absent). Excused sessions don't count against anyone. Tap a column to sort.</p>
  `;

  $view.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.sort;
      // First tap sorts the "best" way: names A–Z, rank 1 first, counts high first.
      const natural = ['name', 'rank', 'lastAbsence'].includes(k) ? 1 : -1;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : natural };
      renderView();
    }),
  );
}

// ---------- History ----------
function viewHistory(season) {
  const players = allPlayers(season);
  const dates = Object.keys(season.sessions || {}).filter((d) => isLogged(season.sessions[d])).sort().reverse();

  $view.innerHTML = `
    <div class="history-head">
      <h2>All sessions</h2>
      <button type="button" class="btn small" id="csv" ${dates.length ? '' : 'disabled'}>Export CSV</button>
    </div>
    ${dates.length ? '' : `<p class="empty">No sessions logged yet.</p>`}
    ${dates.map((d) => {
      const s = season.sessions[d];
      if (s.canceled) {
        return `<div class="session-card is-canceled"><div class="sc-top"><span class="sc-date">${shortDate(d)}</span><span class="muted">Canceled</span></div>
          ${s.note ? `<div class="sc-note">${esc(s.note)}</div>` : ''}
          <button type="button" class="linklike small" data-open="${d}">Open</button></div>`;
      }
      const sum = sessionSummary(s, players);
      const line = (cls, letter, list) => list.length ? `<div class="sc-line ${cls}"><b>${letter}</b>${list.map(esc).join(', ')}</div>` : '';
      return `<div class="session-card">
        <div class="sc-top"><span class="sc-date">${shortDate(d)}</span><span class="sc-pct">${formatPct(sum.pct)}</span></div>
        <div class="sc-counts">${sum.present.length} present · ${sum.absent.length} absent · ${sum.excused.length} excused</div>
        ${line('p', 'P', sum.present)}${line('a', 'A', sum.absent)}${line('e', 'E', sum.excused)}
        ${s.note ? `<div class="sc-note">${esc(s.note)}</div>` : ''}
        <button type="button" class="linklike small" data-open="${d}">${state.canEdit ? 'Edit' : 'Open'}</button>
      </div>`;
    }).join('')}
  `;

  $view.querySelector('#csv').addEventListener('click', () => {
    const blob = new Blob([toCSV(season)], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `study-tables-${season.name}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $view.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      state.date = b.dataset.open;
      state.tab = 'take';
      history.replaceState(null, '', '#take');
      render();
      window.scrollTo(0, 0);
    }),
  );
}

// ---------- Settings ----------
function viewSettings(season) {
  const edit = state.canEdit;
  const active = season.roster.filter((p) => p.active !== false);
  const inactive = season.roster.filter((p) => p.active === false);
  const sch = season.schedule || { days: [], start: today(), end: null };
  const nextName = suggestSeasonName(season.name);

  $view.innerHTML = `
    <h3 class="section-title">Edit access</h3>
    <div class="card">
      ${DEMO ? `<p>Demo mode: sample data in memory, nothing is saved.</p>` : edit
        ? `<p><span class="status-ok">Editing is on for this device.</span></p>
           <button type="button" class="btn small" id="forget-key">Remove key from this device</button>`
        : `<p class="small">${state.keyRejected ? '<b>The saved key was rejected (expired or revoked).</b> ' : ''}Anyone can view. To take attendance, paste the edit key. It is saved only on this device.</p>
           <form id="key-form" class="add-row">
             <input type="password" id="key" autocomplete="off" placeholder="Edit key" aria-label="Edit key" required>
             <button class="btn primary" type="submit">Save</button>
           </form>
           <p class="small muted" id="key-msg"></p>`}
    </div>

    ${edit ? `
    <h3 class="section-title">Roster · ${esc(season.name)}</h3>
    <div class="card">
      <ul class="settings-list">
        ${active.map((p) => `<li><span class="name">${esc(p.name)}</span><span class="btn-row">
          <button type="button" class="btn small" data-rename="${esc(p.name)}">Rename</button>
          <button type="button" class="btn small" data-remove="${esc(p.name)}">Remove</button></span></li>`).join('')}
      </ul>
      <form id="add-form" class="add-row">
        <input type="text" id="new-player" placeholder="First name" aria-label="New player first name" required maxlength="30">
        <button class="btn primary" type="submit">Add</button>
      </form>
      ${inactive.length ? `
        <p class="field-label">Removed (kept in stats history)</p>
        <ul class="settings-list">
          ${inactive.map((p) => `<li><span class="name muted">${esc(p.name)}</span><span class="btn-row">
            <button type="button" class="btn small" data-restore="${esc(p.name)}">Restore</button></span></li>`).join('')}
        </ul>` : ''}
    </div>

    <h3 class="section-title">Schedule &amp; flag</h3>
    <form class="card" id="schedule-form">
      <span class="field-label">Meeting days</span>
      <div class="days">${DAY_NAMES.map((d, i) =>
        `<button type="button" class="btn small" data-day="${i}" aria-pressed="${sch.days.includes(i)}">${d}</button>`).join('')}</div>
      <div class="grid-2">
        <div><label class="field-label" for="start">First session</label><input type="date" id="start" value="${sch.start ?? ''}" required></div>
        <div><label class="field-label" for="end">Last session (optional)</label><input type="date" id="end" value="${sch.end ?? ''}"></div>
      </div>
      <label class="field-label" for="threshold">Flag players under (%)</label>
      <input type="number" id="threshold" min="1" max="100" step="1" value="${Math.round((season.threshold ?? 0.8) * 100)}" required>
      <p class="small muted">Skip a single date (break, exam week) by opening it on the Attendance tab and tapping Cancel session.</p>
      <button class="btn primary" type="submit">Save schedule</button>
      <span class="small muted" id="schedule-msg"></span>
    </form>

    <h3 class="section-title">New school year</h3>
    <form class="card" id="season-form">
      <p class="small">Starts a fresh season with a new roster. The meeting days and flag carry over. ${esc(season.name)} stays viewable from the season menu at the top.</p>
      <div class="grid-2">
        <div><label class="field-label" for="season-name">Season name</label><input type="text" id="season-name" value="${esc(nextName)}" required pattern="[A-Za-z0-9._\\-]+"></div>
        <div><label class="field-label" for="season-start">First session</label><input type="date" id="season-start" required></div>
      </div>
      <label class="field-label" for="season-roster">Freshmen (one first name per line)</label>
      <textarea id="season-roster" required placeholder="Alex&#10;Jordan&#10;Sam"></textarea>
      <button class="btn primary" type="submit">Create season</button>
    </form>` : ''}
  `;

  const keyForm = $view.querySelector('#key-form');
  keyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $view.querySelector('#key').value.trim();
    const msg = $view.querySelector('#key-msg');
    msg.textContent = 'Checking…';
    const probe = new GitHubBackend(DATA_REPO, key);
    if (!(await probe.canWrite().catch(() => false))) {
      msg.textContent = 'That key cannot edit the attendance data. Check it and try again.';
      return;
    }
    store.set(KEY, key);
    state.backend.token = key;
    await checkKey();
  });
  $view.querySelector('#forget-key')?.addEventListener('click', async () => {
    if (!confirm('Remove the edit key from this device? You can paste it again later.')) return;
    await state.sync.flush();
    store.set(KEY, null);
    state.backend.token = null;
    await checkKey();
  });
  if (!edit) return;

  $view.querySelectorAll('[data-rename]').forEach((b) =>
    b.addEventListener('click', () => {
      const from = b.dataset.rename;
      const to = prompt(`Rename ${from} to:`, from)?.trim();
      if (!to || to === from) return;
      if (season.roster.some((p) => p.name === to)) return alert(`${to} is already on the roster.`);
      state.sync.queue({ t: 'rename', from, to }, 0);
      renderView();
    }),
  );
  $view.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.remove;
      if (hasRecords(season, name)) {
        if (!confirm(`Remove ${name} from the roster? Their past attendance stays in the history.`)) return;
        state.sync.queue({ t: 'setActive', name, active: false }, 0);
      } else {
        if (!confirm(`Remove ${name}? They have no attendance yet.`)) return;
        state.sync.queue({ t: 'deletePlayer', name }, 0);
      }
      renderView();
    }),
  );
  $view.querySelectorAll('[data-restore]').forEach((b) =>
    b.addEventListener('click', () => { state.sync.queue({ t: 'setActive', name: b.dataset.restore, active: true }, 0); renderView(); }),
  );
  $view.querySelector('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $view.querySelector('#new-player');
    const name = input.value.trim();
    if (!name) return;
    if (season.roster.some((p) => p.name === name && p.active !== false)) return alert(`${name} is already on the roster.`);
    state.sync.queue({ t: 'addPlayer', name }, 0);
    input.value = '';
    input.blur();
    renderView();
  });

  $view.querySelectorAll('[data-day]').forEach((b) =>
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))),
  );
  $view.querySelector('#schedule-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const days = [...$view.querySelectorAll('[data-day][aria-pressed="true"]')].map((b) => Number(b.dataset.day));
    const start = $view.querySelector('#start').value;
    const end = $view.querySelector('#end').value || null;
    const thr = Number($view.querySelector('#threshold').value);
    const msg = $view.querySelector('#schedule-msg');
    if (!days.length) return (msg.textContent = 'Pick at least one meeting day.');
    if (end && end < start) return (msg.textContent = 'Last session is before the first.');
    if (!(thr >= 1 && thr <= 100)) return (msg.textContent = 'Flag must be 1–100%.');
    document.activeElement?.blur();
    state.sync.queue({ t: 'settings', schedule: { days, start, end }, threshold: thr / 100 }, 0);
    state.date = null;
    renderView();
  });

  $view.querySelector('#season-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $view.querySelector('#season-name').value.trim();
    const start = $view.querySelector('#season-start').value;
    const roster = [...new Set($view.querySelector('#season-roster').value.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (!roster.length) return alert('Add at least one player.');
    if (state.index.seasons.includes(name)) return alert(`Season ${name} already exists.`);
    if (!confirm(`Create season ${name} with ${roster.length} players and make it the current season?`)) return;
    try {
      await state.sync.flush();
      const doc = newSeason(name, roster, { days: season.schedule.days, start, end: null }, season.threshold);
      await state.backend.write(seasonPath(name), doc, null, `Start season ${name}`);
      await updateIndex((idx) => ({ current: name, seasons: [...new Set([...idx.seasons, name])] }));
      store.set(SEASON_PREF, name);
      renderPicker();
      await openSeason(name);
      state.tab = 'take';
      render();
    } catch (err) {
      alert(err instanceof ConflictError ? `Season ${name} already exists.` : err.message);
    }
  });
}

async function updateIndex(change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, sha } = await state.backend.read('index.json');
    const next = change(data);
    try {
      await state.backend.write('index.json', next, sha, `Set current season to ${next.current}`);
      state.index = next;
      return;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new Error('Could not update the season list. Try again.');
}

// "2026-27" -> "2027-28"
function suggestSeasonName(name) {
  const m = /^(\d{4})-(\d{2})$/.exec(name);
  if (!m) return `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`;
  const y = Number(m[1]) + 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

boot();
