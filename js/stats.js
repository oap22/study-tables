// Attendance statistics. Pure functions over a season document; no DOM.
//
// Rules:
// - A session counts once it has at least one mark and is not canceled.
// - Attendance % = Present / (Present + Absent); Excused is ignored.
// - Current streak = Presents since the player's last Absent; Excused is ignored.

import { isLogged } from './dates.js';

// Roster order first, then anyone who has marks but is no longer on the roster.
export function allPlayers(season) {
  const players = season.roster.map((p) => ({ name: p.name, active: p.active !== false }));
  const known = new Set(players.map((p) => p.name));
  for (const date of Object.keys(season.sessions || {}).sort()) {
    for (const name of Object.keys(season.sessions[date].marks || {})) {
      if (!known.has(name)) {
        known.add(name);
        players.push({ name, active: false });
      }
    }
  }
  return players;
}

export function loggedSessions(season) {
  return Object.keys(season.sessions || {})
    .sort()
    .filter((d) => isLogged(season.sessions[d]) && !season.sessions[d].canceled)
    .map((date) => ({ date, ...season.sessions[date] }));
}

const pct = (p, a) => (p + a === 0 ? null : p / (p + a));

export function sessionSummary(session, players) {
  const names = { P: [], A: [], E: [] };
  for (const { name } of players) {
    const m = session.marks?.[name];
    if (m) names[m].push(name);
  }
  return {
    present: names.P,
    absent: names.A,
    excused: names.E,
    pct: pct(names.P.length, names.A.length),
  };
}

function playerStats(name, active, sessions) {
  let present = 0, absent = 0, excused = 0, streak = 0, lastAbsence = null;
  for (const s of sessions) {
    const m = s.marks?.[name];
    if (m === 'P') { present++; streak++; }
    else if (m === 'A') { absent++; streak = 0; lastAbsence = s.date; }
    else if (m === 'E') excused++;
  }
  return { name, active, present, absent, excused, pct: pct(present, absent), streak, lastAbsence };
}

// Every player tied for the top value of `key`. Empty if the top value is `floor` or lower.
function leaders(players, key, floor = 0) {
  const vals = players.map((p) => p[key]).filter((v) => v !== null && v > floor);
  if (!vals.length) return { value: null, players: [] };
  const top = Math.max(...vals);
  return { value: top, players: players.filter((p) => p[key] === top) };
}

export function computeStats(season) {
  const sessions = loggedSessions(season);
  const players = allPlayers(season).map((p) => playerStats(p.name, p.active, sessions));

  // Standard competition ranking by attendance %: 1, 1, 3, ...
  const ranked = players.filter((p) => p.pct !== null).sort((a, b) => b.pct - a.pct);
  for (const p of players) {
    p.rank = p.pct === null ? null : ranked.findIndex((r) => r.pct === p.pct) + 1;
  }

  const totalP = players.reduce((n, p) => n + p.present, 0);
  const totalA = players.reduce((n, p) => n + p.absent, 0);
  const active = players.filter((p) => p.active);
  const threshold = season.threshold ?? 0.8;

  return {
    sessions,
    players,
    highlights: {
      sessionsLogged: sessions.length,
      teamPct: pct(totalP, totalA),
      mostAttended: leaders(active, 'present'),
      highestPct: leaders(active, 'pct', -1),
      perfect: active.filter((p) => p.absent === 0 && p.present > 0),
      mostAbsences: leaders(active, 'absent'),
      longestStreak: leaders(active, 'streak'),
      underThreshold: active
        .filter((p) => p.pct !== null && p.pct < threshold)
        .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name)),
      threshold,
    },
  };
}

export function formatPct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;
}

// Full log, one row per session (canceled ones included), one column per player.
export function toCSV(season) {
  const players = allPlayers(season);
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ['Date', 'Status', 'Present', 'Absent', 'Excused', 'Attendance %', ...players.map((p) => p.name), 'Note'];
  const rows = [header];
  for (const date of Object.keys(season.sessions || {}).sort()) {
    const s = season.sessions[date];
    if (!isLogged(s)) continue;
    const sum = sessionSummary(s, players);
    rows.push([
      date,
      s.canceled ? 'Canceled' : 'Held',
      s.canceled ? '' : String(sum.present.length),
      s.canceled ? '' : String(sum.absent.length),
      s.canceled ? '' : String(sum.excused.length),
      s.canceled ? '' : formatPct(sum.pct).replace('—', ''),
      ...players.map((p) => s.marks?.[p.name] ?? ''),
      s.note ?? '',
    ]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
