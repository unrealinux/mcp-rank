// Verify that the package behind each stdio entry actually exists on its registry.
// Run: node scripts/probe-packages.mjs [limit] [daily]
// Covers npm / pypi / nuget / crates (4 cheap HTTP HEAD/GETs per entry); docker images are
// skipped — hub rate limits make a pass/fail answer unreliable. Results go to
// data/pkg-status.json keyed by server name with the same TTL scheme as probe-status.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LIMIT = Number(process.argv[2] ?? 5_000);
const DAILY = Number(process.argv[3] ?? 400);
const TTL_MS = 30 * 24 * 3600 * 1000;
const FILE = 'data/pkg-status.json';

const list = JSON.parse(readFileSync('data/connectable.json', 'utf8'));
const cache = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { checkedAt: null, results: {} };

// 从 stdio 命令行还原包名（export-connectable 生成的固定形状）。
const pkgOf = (s) => {
  const c = s.connect;
  if (c.kind !== 'stdio') return null;
  const tokens = (c.args ?? []).filter((a) => !a.startsWith('-'));
  if (c.type === 'npm') {
    const t = tokens[0];
    // 裸/带 scope/带版本都能剥：'@scope/name@1.0' → '@scope/name'，'name@1.0' → 'name'
    return t ? t.match(/^(?:@[^/]+\/)?[^@]+/)?.[0] ?? null : null;
  }
  if (c.type === 'pypi') return tokens[0]?.split('==')[0] ?? null;
  if (c.type === 'nuget') return tokens[0]?.split('@')[0]?.toLowerCase() ?? null;
  if (c.type === 'cargo') return c.args?.[(c.args || []).indexOf('install') + 1] ?? null;
  return null; // docker/oci：不查
};

const registryCheck = {
  npm: (id) => `https://registry.npmjs.org/${id.replace(/[^@a-zA-Z0-9/_.~-]/g, encodeURIComponent)}`,
  pypi: (id) => `https://pypi.org/pypi/${encodeURIComponent(id)}/json`,
  nuget: (id) => `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`,
  cargo: (id) => `https://crates.io/api/v1/crates/${encodeURIComponent(id)}`,
};

const targets = list
  .filter((s) => s.connect.kind === 'stdio')
  .map((s) => ({ s, pkg: pkgOf(s) }))
  .filter(({ pkg }) => pkg)
  .slice(0, LIMIT);
const expired = (r) => !r || Date.now() - new Date(r.at).getTime() > TTL_MS;
let todo = targets.filter(({ s }) => expired(cache.results[s.name])).slice(0, DAILY);
const skipped = list.filter((s) => s.connect.kind === 'stdio' && !pkgOf(s)).length;
console.error(`${targets.length} stdio entries with a checkable package, ${todo.length} to probe (daily cap ${DAILY}), ${skipped} docker skip`);

if (!todo.length) process.exit(0);

const CONCURRENCY = 6;
const TIMEOUT_MS = 10_000;

const check = async (type, pkg) => {
  const url = registryCheck[type]?.(pkg);
  if (!url) return { status: 'unknown', at: new Date().toISOString() };
  const headers =
    type === 'cargo'
      ? { 'User-Agent': 'mcp-rank (package existence check)' } // crates.io 要求 UA
      : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.ok ? 'ok' : res.status === 404 ? 'missing' : 'unknown', http: res.status, at: new Date().toISOString() };
  } catch (err) {
    // 拿不到明确答案就不毁掉旧状态：unknown ≠ missing
    return { status: 'unknown', error: err.cause?.code ?? err.name, at: new Date().toISOString() };
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
    const entry = todo[i++];
    cache.results[entry.s.name] = { pkg: entry.pkg, ...(await check(entry.s.connect.type, entry.pkg)) };
    if (++done % 50 === 0) {
      save();
      console.error(`probed ${done}/${todo.length}`);
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
save();

const tally = {};
for (const r of Object.values(cache.results)) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log('pkg status:', tally, '→', FILE);
