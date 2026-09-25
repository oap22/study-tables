// Storage: JSON files in a GitHub repository, read and written through the
// GitHub contents API. Every save is a commit, so the full history is kept.

import { applyOps } from './model.js';

export class ConflictError extends Error {}
export class AuthError extends Error {}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class GitHubBackend {
  constructor({ owner, repo, branch = 'main' }, token = null, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.fetch = fetchImpl;
  }

  headers() {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  url(path) {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
  }

  // Returns { data, sha }. sha is null when read through the raw fallback.
  async read(path) {
    const res = await this.fetch(`${this.url(path)}?ref=${this.branch}&t=${Date.now()}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (res.ok) {
      const body = await res.json();
      return { data: JSON.parse(decodeBase64(body.content)), sha: body.sha };
    }
    if (res.status === 401) throw new AuthError('The edit key was rejected.');
    if (res.status === 404) return { data: null, sha: null };
    // Unauthenticated API reads are rate limited; fall back to the raw file.
    if ((res.status === 403 || res.status === 429) && !this.token) {
      const raw = await this.fetch(
        `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}?t=${Date.now()}`,
        { cache: 'no-store' },
      );
      if (raw.ok) return { data: await raw.json(), sha: null };
    }
    throw new Error(`Could not load ${path} (${res.status}).`);
  }

  // Creates or replaces a file. Returns the new sha.
  async write(path, data, sha, message) {
    const res = await this.fetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: encodeBase64(JSON.stringify(data, null, 2) + '\n'),
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.ok) return (await res.json()).content.sha;
    if (res.status === 409 || res.status === 422) throw new ConflictError(`${path} changed on the server.`);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new AuthError('The edit key cannot write to the data repository.');
    }
    throw new Error(`Save failed (${res.status}).`);
  }

  // True when the key can push to the data repo.
  async canWrite() {
    if (!this.token) return false;
    const res = await this.fetch(`https://api.github.com/repos/${this.owner}/${this.repo}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const body = await res.json();
    return !!body.permissions?.push;
  }
}

// In-memory backend for local testing (only used on localhost with ?demo).
export class MemoryBackend {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files).map(([k, v]) => [k, { data: v, sha: 'v0' }]));
    this.n = 0;
    this.token = 'memory';
  }
  async read(path) {
    const f = this.files.get(path);
    return f ? { data: structuredClone(f.data), sha: f.sha } : { data: null, sha: null };
  }
  async write(path, data, sha) {
    const f = this.files.get(path);
    if ((f?.sha ?? null) !== (sha ?? null)) throw new ConflictError(`${path} changed.`);
    const next = `v${++this.n}`;
    this.files.set(path, { data: structuredClone(data), sha: next });
    return next;
  }
  async canWrite() {
    return true;
  }
}

// Keeps one season file in sync: edits are queued as operations, shown
// immediately, and saved in the background. On a conflict the latest file is
// fetched and the queued operations are replayed on top of it.
export class SeasonSync {
  constructor(backend, path, onChange = () => {}) {
    this.backend = backend;
    this.path = path;
    this.onChange = onChange;
    this.server = null;
    this.sha = null;
    this.pending = [];
    this.status = 'idle';
    this.error = null;
    this.timer = null;
    this.flushing = null;
  }

  get view() {
    return this.server ? applyOps(this.server, this.pending) : null;
  }

  async load() {
    const { data, sha } = await this.backend.read(this.path);
    if (!data) throw new Error(`Season file ${this.path} not found.`);
    this.server = data;
    this.sha = sha;
    this.onChange(true);
  }

  queue(op, delay = 600) {
    this.pending.push(op);
    this.setStatus('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  // onChange(dataChanged): dataChanged is true only when another device's edits
  // were pulled in, so the page doesn't redraw under the user's finger on every save.
  setStatus(status, error = null, dataChanged = false) {
    this.status = status;
    this.error = error;
    this.onChange(dataChanged);
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.flushing) {
      await this.flushing;
      if (this.pending.length) return this.flush();
      return;
    }
    if (!this.pending.length) return;
    this.flushing = this.#save().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async #save() {
    const ops = this.pending.slice();
    let refetched = false;
    this.setStatus('saving');
    try {
      for (let attempt = 0; ; attempt++) {
        const merged = applyOps(this.server, ops);
        try {
          this.sha = await this.backend.write(this.path, merged, this.sha, commitMessage(ops));
          this.server = merged;
          break;
        } catch (e) {
          if (!(e instanceof ConflictError) || attempt >= 4) throw e;
          const latest = await this.backend.read(this.path);
          this.server = latest.data;
          this.sha = latest.sha;
          refetched = true;
        }
      }
      this.pending = this.pending.slice(ops.length);
      this.setStatus(this.pending.length ? 'pending' : 'saved', null, refetched);
      if (this.pending.length) this.timer = setTimeout(() => this.flush(), 200);
    } catch (e) {
      this.setStatus('error', e, refetched);
    }
  }
}

function commitMessage(ops) {
  if (!ops.every((o) => o.date)) return 'Update roster/settings';
  return `Attendance ${[...new Set(ops.map((o) => o.date))].join(', ')}`;
}
