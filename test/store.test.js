import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MemoryBackend, SeasonSync } from '../js/store.js';

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/sample-season.json', import.meta.url)));
const PATH = 'seasons/sample.json';

test('two editors marking the same session do not overwrite each other', async () => {
  const backend = new MemoryBackend({ [PATH]: sample() });
  const a = new SeasonSync(backend, PATH);
  const b = new SeasonSync(backend, PATH);
  await a.load();
  await b.load();

  a.queue({ t: 'mark', date: '2026-09-28', name: 'Bryce', value: 'P' });
  b.queue({ t: 'mark', date: '2026-09-28', name: 'Seba', value: 'A' });
  await a.flush();
  await b.flush(); // b's sha is stale: must refetch and replay

  const { data } = await backend.read(PATH);
  assert.deepEqual(data.sessions['2026-09-28'].marks, { Bryce: 'P', Seba: 'A' });
  assert.equal(b.status, 'saved');
  assert.equal(b.pending.length, 0);
});

test('edits show immediately and clearing the last mark removes the session', async () => {
  const backend = new MemoryBackend({ [PATH]: sample() });
  const s = new SeasonSync(backend, PATH);
  await s.load();
  s.queue({ t: 'mark', date: '2026-09-28', name: 'Cole', value: 'E' });
  assert.equal(s.view.sessions['2026-09-28'].marks.Cole, 'E');
  s.queue({ t: 'mark', date: '2026-09-28', name: 'Cole', value: null });
  await s.flush();
  assert.equal((await backend.read(PATH)).data.sessions['2026-09-28'], undefined);
});
