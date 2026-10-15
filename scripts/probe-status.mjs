// Probe remote MCP endpoints and cache the result to data/status.json.
// Run: node scripts/probe-status.mjs [limit]     (default 500; already-probed entries are skipped)
// Targets = the same order the site ranks by (stars first) plus the curated vendor-official rows.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LIMIT = Number(process.argv[2] ?? 500);
// 4, not 25: higher concurrency exhausts local connections and reports false timeouts.
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const FILE = 'data/status.json';

const list = JSON.parse(readFileSync('data/connectable.json', 'utf8'));
const stars = JSON.parse(readFileSync('data/repo-stars.json', 'utf8'));
const GH = /^https?:\/\/(?:www\.)?github\.com\//i;
const starsOf = (s) => (s.repo ? (stars[s.repo.replace(GH, '').replace(/\.git$/i, '')]?.stars ?? 0) : 0);

const byStars = [...list].sort((a, b) => starsOf(b) - starsOf(a)).slice(0, LIMIT);
const targets = [...new Map([...byStars, ...list.filter((s) => s.official)].map((s) => [s.name, s])).values()]
  .filter((s) => s.connect.kind === 'remote' && !/\{[^}]*\}/.test(s.connect.url)); // {placeholder} URLs need manual editing

const cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { checkedAt: null, results: {} };
const todo = targets.filter((s) => !cache.results[s.name]);
console.error(`${targets.length} targets, ${todo.length} to probe`);
if (!todo.length) process.exit(0);

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-rank-probe', version: '1' } },
});

const probe = async (url) => {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    const text = await res.text().catch(() => '');
    const ms = Date.now() - t0;
    if (res.ok && /"result"|"jsonrpc"/.test(text)) return { status: 'ok', http: res.status, ms };
    if (res.status === 401 || res.status === 403) return { status: 'auth', http: res.status, ms };
    return { status: 'error', http: res.status, ms };
  } catch (err) {
    return { status: 'dead', ms: Date.now() - t0, error: err.cause?.code ?? err.name };
  }
};

let i = 0;
let done = 0;
const save = () => {
  cache.checkedAt = new Date().toISOString();
  writeFileSync(FILE, JSON.stringify(cache, null, 1));
};
const worker = async () => {
  while (i < todo.length) {
    const s = todo[i++];
    cache.results[s.name] = { ...(await probe(s.connect.url)), at: new Date().toISOString() };
    if (++done % 25 === 0) {
      save();
      console.error(`probed ${done}/${todo.length}`);
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
save();

const tally = {};
for (const r of Object.values(cache.results)) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log('status:', tally, '→', FILE);
