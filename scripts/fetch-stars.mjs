// Fetch GitHub stars for every repo referenced by data/servers.json.
// Caches to data/repo-stars.json. Re-runs fetch repos that are new or whose cached copy is
// older than STAR_TTL_DAYS — stars carry 45-75% of the ranking weight, so they must track
// reality instead of freezing at the first fetch.
// Needs GH_TOKEN (or GITHUB_TOKEN). Run: GH_TOKEN=$(gh auth token) node scripts/fetch-stars.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('set GH_TOKEN, e.g. GH_TOKEN=$(gh auth token)');

const servers = JSON.parse(readFileSync('data/servers.json', 'utf8'));
const official = existsSync('data/official-list.json') ? JSON.parse(readFileSync('data/official-list.json', 'utf8')) : [];
const repos = [...new Set([...servers.map((s) => s.repo), ...official.map((s) => s.repo)].filter(Boolean))];
const cache = existsSync('data/repo-stars.json') ? JSON.parse(readFileSync('data/repo-stars.json', 'utf8')) : {};
const STAR_TTL_MS = 7 * 24 * 3600 * 1000;
const isStale = (entry) => !entry?.fetchedAt || Date.now() - entry.fetchedAt > STAR_TTL_MS;
const todo = repos.filter((r) => isStale(cache[r]));
console.error(`${repos.length} repos, ${todo.length} to fetch (new or older than ${STAR_TTL_MS / 86_400_000}d)`);

const BATCH = 60;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const query = `query{${batch
    .map((r, j) => {
      const [owner, name] = r.split('/');
      return `r${j}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){stargazerCount forkCount pushedAt}`;
    })
    .join(' ')}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'mcp-rank' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json();
  // NOT_FOUND for a single repo is normal (deleted/renamed); only bail when nothing came back.
  if (!res.ok || !body.data) throw new Error(`${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  batch.forEach((repo, j) => {
    const d = body.data[`r${j}`];
    // Deleted/renamed repos are cached as { missing: true } (not null) so they stop being
    // re-queried every run; the TTL still re-checks them periodically in case they return.
    cache[repo] = d
      ? { stars: d.stargazerCount, forks: d.forkCount, pushedAt: d.pushedAt, fetchedAt: Date.now() }
      : { missing: true, fetchedAt: Date.now() };
  });
  console.error(`fetched ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
}

writeFileSync('data/repo-stars.json', JSON.stringify(cache, null, 1));
console.error('stars cached for', Object.keys(cache).length, 'repos');
