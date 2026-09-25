// Date helpers. All dates are local calendar days stored as "YYYY-MM-DD".

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO() {
  return toISO(new Date());
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function weekday(iso) {
  return parseISO(iso).getDay();
}

// "Mon 9/14/26"
export function shortDate(iso) {
  const d = parseISO(iso);
  return `${DAY_NAMES[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

// "Monday, Sep 14"
export function longDate(iso) {
  const d = parseISO(iso);
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${full[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Scheduled dates from schedule.start through `until` (capped by schedule.end).
export function scheduledDates(schedule, until) {
  const out = [];
  if (!schedule?.start || !schedule.days?.length) return out;
  const last = schedule.end && schedule.end < until ? schedule.end : until;
  for (let d = schedule.start; d <= last; d = addDays(d, 1)) {
    if (schedule.days.includes(weekday(d))) out.push(d);
  }
  return out;
}

export function isLogged(session) {
  if (!session) return false;
  return !!session.canceled || Object.keys(session.marks || {}).length > 0;
}

// How far ahead the attendance screen can page: 8 weeks past today, or past
// the first session when the season hasn't started yet.
const HORIZON_DAYS = 56;
function horizon(season, today) {
  const start = season.schedule?.start;
  return addDays(start && start > today ? start : today, HORIZON_DAYS);
}

// Every date the attendance screen can show: the schedule plus any date that
// already has a record (e.g. after the meeting days were changed).
export function navigableDates(season, today) {
  const set = new Set(scheduledDates(season.schedule, horizon(season, today)));
  for (const d of Object.keys(season.sessions || {})) set.add(d);
  return [...set].sort();
}

// The session the attendance screen opens on: the earliest scheduled date on or
// after today that has not been logged yet.
export function nextSessionDate(season, today) {
  const dates = scheduledDates(season.schedule, horizon(season, today));
  return dates.find((d) => d >= today && !isLogged(season.sessions?.[d])) ?? null;
}

// Scheduled dates before today that were never logged or canceled.
export function missedDates(season, today) {
  return scheduledDates(season.schedule, addDays(today, -1)).filter(
    (d) => !isLogged(season.sessions?.[d]),
  );
}
