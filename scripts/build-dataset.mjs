// Turn data/raw-registry.jsonl into data/servers.json (latest version per server name).
// Run: node scripts/build-dataset.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const rows = readFileSync('data/raw-registry.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const latest = new Map();
for (const row of rows) {
  if (!row._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) continue;
  latest.set(row.server.name, row);
}

const repoOf = (url) =>
  /github\.com\/([^/]+)\/([^/#?]+)/i.exec(url ?? '')?.slice(1, 3).join('/').replace(/\.git$/i, '') ?? null;

const servers = [...latest.values()].map(({ server, _meta }) => ({
  id: server.name,
  name: server.name,
  namespace: server.name.includes('/') ? server.name.split('/')[0] : server.name,
  title: server.title ?? null,
  description: (server.description ?? '').trim() || null,
  repo: repoOf(server.repository?.url),
  repoUrl: server.repository?.url ?? null,
  website: server.websiteUrl ?? null,
  icon: server.icons?.[0]?.src ?? null,
  version: server.version ?? null,
  remoteCount: server.remotes?.length ?? 0,
  remoteTypes: [...new Set((server.remotes ?? []).map((r) => r.type))],
  remotes: (server.remotes ?? []).map((r) => ({ type: r.type, url: r.url })),
  packageTypes: [...new Set((server.packages ?? []).map((p) => p.registryType))],
  publishedAt: _meta?.['io.modelcontextprotocol.registry/official']?.publishedAt ?? null,
  updatedAt: _meta?.['io.modelcontextprotocol.registry/official']?.updatedAt ?? null,
}));

writeFileSync('data/servers.json', JSON.stringify(servers, null, 1));
console.log(`servers: ${servers.length}, with github repo: ${servers.filter((s) => s.repo).length}`);
