// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeStats, formatPct, toCSV, sessionSummary, allPlayers } from '../js/stats.js';
import { nextSessionDate, missedDates, scheduledDates } from '../js/dates.js';
import { applyOps } from '../js/model.js';

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/sample-season.json', import.meta.url)));
const names = (list) => list.map((p) => p.name).sort();

test('expected results from the sample data', () => {
  const { highlights: h, players } = computeStats(sample());
  assert.equal(h.sessionsLogged, 4);
  assert.equal(formatPct(h.teamPct), '84%');
  assert.deepEqual(names(h.mostAttended.players), ['Bryce', 'Pawel', 'Wyatt']);
  assert.equal(h.mostAttended.value, 4);
  assert.deepEqual(names(h.perfect), ['Andy', 'Bryce', 'Gunnar', 'Pawel', 'Wyatt']);
  assert.deepEqual(names(h.highestPct.players), ['Andy', 'Bryce', 'Gunnar', 'Pawel', 'Wyatt']);
  assert.deepEqual(names(h.mostAbsences.players), ['Dean']);
  assert.equal(h.mostAbsences.value, 2);
  assert.equal(formatPct(h.mostAbsences.players[0].pct), '50%');
  assert.deepEqual(names(h.longestStreak.players), ['Bryce', 'Pawel', 'Wyatt']);
  assert.equal(h.longestStreak.value, 4);
  assert.deepEqual(
    h.underThreshold.map((p) => `${p.name} ${formatPct(p.pct)}`),
    ['Andrew 75%', 'Cole 75%', 'Ryan 75%', 'Seba 75%', 'Dean 50%'],
  );

  const by = Object.fromEntries(players.map((p) => [p.name, p]));
  assert.deepEqual([by.Gunnar.present, by.Gunnar.absent, by.Gunnar.excused, by.Gunnar.streak], [3, 0, 1, 3]);
  assert.equal(by.Dean.lastAbsence, '2026-09-21');
  assert.equal(by.Bryce.lastAbsence, null);
  assert.equal(by.Bryce.rank, 1);
  assert.equal(by.Seba.rank, 6);
  assert.equal(by.Dean.rank, 10);
});

test('next session after the sample data is Mon 9/28/26', () => {
  assert.equal(nextSessionDate(sample(), '2026-09-24'), '2026-09-28');
  assert.equal(nextSessionDate(sample(), '2026-09-25'), '2026-09-28');
  assert.deepEqual(missedDates(sample(), '2026-09-29'), ['2026-09-28']);
});

test('next session is today when today is an unlogged meeting day', () => {
  const s = sample();
  s.sessions = {};
  assert.equal(nextSessionDate(s, '2026-09-24'), '2026-09-24');
});

test('a season starting months from now opens on its first session', () => {
  const s = sample();
  s.sessions = {};
  s.schedule.start = '2027-09-13';
  assert.equal(nextSessionDate(s, '2026-09-24'), '2027-09-13');
});

test('schedule respects meeting days and end date', () => {
  const dates = scheduledDates({ days: [1, 4], start: '2026-09-14', end: '2026-09-24' }, '2026-12-31');
  assert.deepEqual(dates, ['2026-09-14', '2026-09-17', '2026-09-21', '2026-09-24']);
  const wed = scheduledDates({ days: [3], start: '2026-09-14', end: null }, '2026-09-30');
  assert.deepEqual(wed, ['2026-09-16', '2026-09-23', '2026-09-30']);
});

test('only-excused player has no percentage and no rank', () => {
  const s = applyOps(sample(), [{ t: 'addPlayer', name: 'Newbie' }, { t: 'mark', date: '2026-09-24', name: 'Newbie', value: 'E' }]);
  const p = computeStats(s).players.find((p) => p.name === 'Newbie');
  assert.equal(p.pct, null);
  assert.equal(formatPct(p.pct), '—');
  assert.equal(p.rank, null);
  assert.ok(!computeStats(s).highlights.underThreshold.some((x) => x.name === 'Newbie'));
});

test('canceled sessions are left out of every stat', () => {
  const s = applyOps(sample(), [{ t: 'session', date: '2026-09-24', canceled: true, note: 'Exam week' }]);
  const { highlights: h } = computeStats(s);
  assert.equal(h.sessionsLogged, 3);
  assert.equal(h.mostAttended.value, 3);
  assert.equal(nextSessionDate(s, '2026-09-24'), '2026-09-28');
  assert.match(toCSV(s), /2026-09-24,Canceled,,,,,/);
});

test('excused does not break a streak; absent resets it', () => {
  const { players } = computeStats(sample());
  const by = Object.fromEntries(players.map((p) => [p.name, p]));
  assert.equal(by.Andy.streak, 3); // P P E P
  assert.equal(by.Cole.streak, 0); // last session absent
  assert.equal(by.Seba.streak, 1);
});

test('rename carries history; inactive players drop out of highlights', () => {
  let s = applyOps(sample(), [{ t: 'rename', from: 'Dean', to: 'Deano' }]);
  let st = computeStats(s);
  assert.deepEqual(names(st.highlights.mostAbsences.players), ['Deano']);
  s = applyOps(s, [{ t: 'setActive', name: 'Deano', active: false }]);
  st = computeStats(s);
  assert.ok(st.players.some((p) => p.name === 'Deano' && !p.active));
  assert.ok(!st.highlights.underThreshold.some((p) => p.name === 'Deano'));
  assert.deepEqual(names(st.highlights.mostAbsences.players), ['Andrew', 'Cole', 'Ryan', 'Seba']);
});

test('session summary and CSV', () => {
  const s = sample();
  const sum = sessionSummary(s.sessions['2026-09-14'], allPlayers(s));
  assert.deepEqual([sum.present.length, sum.absent, sum.excused], [7, ['Andrew', 'Dean'], ['Gunnar']]);
  assert.equal(formatPct(sum.pct), '78%');
  const csv = toCSV(s).trim().split('\n');
  assert.equal(csv.length, 5);
  assert.equal(csv[0], 'Date,Status,Present,Absent,Excused,Attendance %,Andrew,Andy,Bryce,Cole,Dean,Gunnar,Pawel,Ryan,Seba,Wyatt,Note');
  assert.equal(csv[1], '2026-09-14,Held,7,2,1,78%,A,P,P,P,A,E,P,P,P,P,');
});

test('players are listed alphabetically, including ones added later', () => {
  const s = applyOps(sample(), [{ t: 'addPlayer', name: 'aaron' }, { t: 'addPlayer', name: 'Zed' }]);
  assert.deepEqual(allPlayers(s).map((p) => p.name),
    ['aaron', 'Andrew', 'Andy', 'Bryce', 'Cole', 'Dean', 'Gunnar', 'Pawel', 'Ryan', 'Seba', 'Wyatt', 'Zed']);
  const sum = sessionSummary(s.sessions['2026-09-17'], allPlayers(s));
  assert.deepEqual(sum.present, ['Andrew', 'Andy', 'Bryce', 'Cole', 'Dean', 'Gunnar', 'Pawel', 'Seba', 'Wyatt']);
});

test('empty season has no stats and no errors', () => {
  const s = sample();
  s.sessions = {};
  const { highlights: h } = computeStats(s);
  assert.equal(h.sessionsLogged, 0);
  assert.equal(h.teamPct, null);
  assert.deepEqual(h.mostAttended.players, []);
  assert.deepEqual(h.perfect, []);
});
