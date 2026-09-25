// Season document edits. Every change is an operation so that edits made on
// two phones at once can be replayed on top of whatever was saved last.
//
// Season document shape (seasons/<name>.json in the data repo):
// {
//   "name": "2026-27",
//   "roster": [{ "name": "Bryce", "active": true }, ...],
//   "schedule": { "days": [1, 4], "start": "2026-09-24", "end": null },
//   "threshold": 0.8,
//   "sessions": { "2026-09-24": { "canceled": false, "note": "", "marks": { "Bryce": "P" } } }
// }
// Days use JavaScript numbering: 0 = Sunday, 1 = Monday, ... 6 = Saturday.

export const MARKS = ['P', 'A', 'E'];

export function newSeason(name, roster, schedule, threshold = 0.8) {
  return {
    name,
    roster: roster.map((n) => ({ name: n, active: true })),
    schedule: { days: [...schedule.days].sort(), start: schedule.start, end: schedule.end || null },
    threshold,
    sessions: {},
  };
}

function session(doc, date) {
  doc.sessions ??= {};
  return (doc.sessions[date] ??= { canceled: false, note: '', marks: {} });
}

function prune(doc, date) {
  const s = doc.sessions?.[date];
  if (s && !s.canceled && !s.note && Object.keys(s.marks || {}).length === 0) delete doc.sessions[date];
}

// Applies one operation to `doc` in place and returns it.
export function applyOp(doc, op) {
  switch (op.t) {
    case 'mark': {
      const s = session(doc, op.date);
      if (op.value) s.marks[op.name] = op.value;
      else delete s.marks[op.name];
      prune(doc, op.date);
      break;
    }
    case 'marks': {
      // Bulk version of 'mark' for "all present" and "clear".
      const s = session(doc, op.date);
      for (const [name, value] of Object.entries(op.marks)) {
        if (value) s.marks[name] = value;
        else delete s.marks[name];
      }
      prune(doc, op.date);
      break;
    }
    case 'session': {
      const s = session(doc, op.date);
      if ('canceled' in op) s.canceled = op.canceled;
      if ('note' in op) s.note = op.note;
      prune(doc, op.date);
      break;
    }
    case 'addPlayer': {
      const existing = doc.roster.find((p) => p.name === op.name);
      if (existing) existing.active = true;
      else doc.roster.push({ name: op.name, active: true });
      break;
    }
    case 'setActive': {
      const p = doc.roster.find((p) => p.name === op.name);
      if (p) p.active = op.active;
      break;
    }
    case 'deletePlayer': {
      doc.roster = doc.roster.filter((p) => p.name !== op.name);
      break;
    }
    case 'rename': {
      if (doc.roster.some((p) => p.name === op.to)) break;
      const p = doc.roster.find((p) => p.name === op.from);
      if (p) p.name = op.to;
      for (const s of Object.values(doc.sessions || {})) {
        if (s.marks && op.from in s.marks) {
          s.marks[op.to] = s.marks[op.from];
          delete s.marks[op.from];
        }
      }
      break;
    }
    case 'settings': {
      if (op.schedule) doc.schedule = { ...op.schedule, days: [...op.schedule.days].sort() };
      if ('threshold' in op) doc.threshold = op.threshold;
      break;
    }
    default:
      throw new Error(`Unknown operation: ${op.t}`);
  }
  return doc;
}

export function applyOps(doc, ops) {
  const copy = structuredClone(doc);
  for (const op of ops) applyOp(copy, op);
  return copy;
}

// Players with any record in this season (they can be hidden but not deleted).
export function hasRecords(doc, name) {
  return Object.values(doc.sessions || {}).some((s) => s.marks && name in s.marks);
}
