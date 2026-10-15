// Fetch GitHub stars for every repo referenced by data/servers.json.
// Caches to data/repo-stars.json so re-runs only fetch what is missing.
// Needs GH_TOKEN (or GITHUB_TOKEN). Run: GH_TOKEN=$(gh auth token) node scripts/fetch-stars.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('set GH_TOKEN, e.g. GH_TOKEN=$(gh auth token)');

const servers = JSON.parse(readFileSync('data/servers.json', 'utf8'));
const official = existsSync('data/official-list.json') ? JSON.parse(readFileSync('data/official-list.json', 'utf8')) : [];
const repos = [...new Set([...servers.map((s) => s.repo), ...official.map((s) => s.repo)].filter(Boolean))];
const cache = existsSync('data/repo-stars.json') ? JSON.parse(readFileSync('data/repo-stars.json', 'utf8')) : {};
const todo = repos.filter((r) => !cache[r]);
console.error(`${repos.length} repos, ${todo.length} to fetch`);

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
    cache[repo] = d ? { stars: d.stargazerCount, forks: d.forkCount, pushedAt: d.pushedAt } : null;
  });
  console.error(`fetched ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
}

writeFileSync('data/repo-stars.json', JSON.stringify(cache, null, 1));
console.error('stars cached for', Object.keys(cache).length, 'repos');
