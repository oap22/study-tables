# Study Tables

Attendance tracker for freshman study tables, built for phones.
Live site: https://oap22.github.io/study-tables/

- **Site code** (this repo) is plain HTML/CSS/JS with no build step, served by GitHub Pages.
- **Attendance data** lives in [oap22/study-tables-data](https://github.com/oap22/study-tables-data). Every save is a commit there, so nothing is ever lost and any change can be undone from its history.

Anyone with the link can view. Editing needs the **edit key**, which you paste once per device under Settings.

## Taking attendance

1. Open the site. It lands on today's session, or the next one if today's is already done.
2. Tap **All present**, then tap anyone who isn't there: one tap = Absent, two taps = Excused. A single tap on an unmarked name marks them Present.
3. It saves on its own ("Saved" in the top right). Add a note or tap **Cancel session** if study tables didn't happen. Canceled sessions are left out of every stat.

Use the ‹ › arrows or History → Edit to fix an earlier session.

## New school year / roster changes

All of this happens under **Settings** on the site. No code changes needed.

- **Add, rename, or remove a player.** A removed player keeps their past attendance in the history but drops out of highlights and the attendance list.
- **Change meeting days, first/last session date, or the flag threshold** under Schedule & flag.
- **New school year:** under New school year, type the season name (e.g. `2027-28`), the first session date, and the freshmen (one first name per line). The old season stays viewable from the menu in the top bar.

To skip a single date (break, exam week), open it on the Attendance tab and tap **Cancel session**.

The same data can also be edited by hand on GitHub: `index.json` lists the seasons, and `seasons/<name>.json` holds one season's roster, schedule, threshold and sessions (`days` uses 0 = Sunday … 6 = Saturday).

## Making an edit key

Only the owner of the data repo can create a key.

1. Go to https://github.com/settings/personal-access-tokens/new (fine-grained token).
2. Name: `study-tables edit`. Expiration: up to 1 year.
3. Repository access: **Only select repositories** → `oap22/study-tables-data`.
4. Permissions → Repository permissions → **Contents: Read and write**. Leave everything else as is.
5. Generate, copy the key, and paste it into Settings → Edit access on each phone or laptop. Send it privately to anyone else who takes attendance.

The key can only change files in the data repo, not this site. If a key leaks, delete it on GitHub and make a new one. Past data can be restored from the data repo's commit history.

## Stats rules

- Attendance % = Present ÷ (Present + Absent). Excused never counts against anyone; only-excused shows "—".
- Current streak = Presents since the last Absent; Excused doesn't break it.
- Ties are all listed. Rank is standard competition ranking (1, 1, 3…).

## Development

```
node --test                      # stats, schedule, and save/merge tests
python3 -m http.server 8765      # then open http://localhost:8765/?demo
```

`?demo` (localhost only) runs on the sample data in `test/fixtures` in memory. Add `&today=2026-09-24` to fake the date.
