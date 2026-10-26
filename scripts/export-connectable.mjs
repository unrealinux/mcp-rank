// Export a flat, connect-ready MCP list from the crawled official registry.
// Output: data/connectable.json (machine) + data/connectable.md (human).
// Run: node scripts/export-connectable.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const latest = new Map();
for (const line of readFileSync('data/raw-registry.jsonl', 'utf8').split('\n')) {
  if (!line) continue;
  const row = JSON.parse(line);
  if (row._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) latest.set(row.server.name, row.server);
}

// Registry names already curated in data/catalog.json (the 296 vendor-official ones).
const officialNames = new Set(
  JSON.parse(readFileSync('data/catalog.json', 'utf8')).map((s) => s.registryName).filter(Boolean),
);

// 名字第一次被爬到的日期（crawl-registry.mjs 维护）。null = 补种时代码运行前就已存在。
const seen = existsSync('data/first-seen.json') ? JSON.parse(readFileSync('data/first-seen.json', 'utf8')) : {};

const STDIO = {
  npm: (id, v) => ({ command: 'npx', args: ['-y', v ? `${id}@${v}` : id] }),
  pypi: (id, v) => ({ command: 'uvx', args: [v ? `${id}==${v}` : id] }),
  nuget: (id, v) => ({ command: 'dnx', args: [v ? `${id}@${v}` : id] }),
  cargo: (id) => ({ command: 'cargo', args: ['install', id] }),
  oci: (id) => ({ command: 'docker', args: ['run', '-i', '--rm', id] }),
};

const list = [];
for (const s of latest.values()) {
  const remotes = s.remotes ?? [];
  const remote = remotes.find((r) => r.type === 'streamable-http') ?? remotes[0];
  const packages = s.packages ?? [];
  const pkg = packages.find((p) => STDIO[p.registryType]) ?? packages[0];

  const connect = remote
    ? { kind: 'remote', type: remote.type, url: remote.url }
    : pkg && STDIO[pkg.registryType]
      ? { kind: 'stdio', type: pkg.registryType, version: pkg.version ?? null, ...STDIO[pkg.registryType](pkg.identifier, pkg.version) }
      : pkg
        ? { kind: 'download', type: pkg.registryType, url: pkg.identifier } // .mcpb bundle: URL, not a command
        : null;
  if (!connect) continue;

  list.push({
    name: s.name,
    title: s.title ?? s.name,
    description: (s.description ?? '').trim(),
    official: officialNames.has(s.name),
    repo: s.repository?.url ?? null,
    website: s.websiteUrl ?? null,
    version: s.version ?? null,
    since: seen[s.name] ?? null, // 首次被发现日期；null = 未知（补种前就存在）
    connect,
  });
}

list.sort((a, b) => Number(b.official) - Number(a.official) || a.title.localeCompare(b.title));
if (!list.length) throw new Error('0 connectable servers — registry data missing?');

writeFileSync('data/connectable.json', JSON.stringify(list, null, 1));

const line = (s) => {
  const how = s.connect.kind === 'remote' ? s.connect.url
    : s.connect.kind === 'stdio' ? `\`${s.connect.command} ${s.connect.args.join(' ')}\``
      : s.connect.url;
  const link = s.repo ?? s.website;
  return `- **${s.title}** — ${how}${link ? ` · <${link}>` : ''}`;
};

const md = [
  '# 可接入 Agent 的公开 MCP server',
  '',
  `来源：MCP 官方 Registry 全量抓取（\`data/raw-registry.jsonl\`），共 ${list.length} 条。`,
  'Remote 条目直接填 URL；stdio 条目在本地起进程。',
  '',
  `## 厂商官方（${list.filter((s) => s.official).length} 条）`,
  '',
  ...list.filter((s) => s.official).map(line),
  '',
  `## Registry 其余收录（${list.filter((s) => !s.official).length} 条，未做社区/垃圾过滤）`,
  '',
  ...list.filter((s) => !s.official).map(line),
  '',
].join('\n');
writeFileSync('data/connectable.md', md);

const by = {};
for (const s of list) by[s.connect.kind] = (by[s.connect.kind] ?? 0) + 1;
console.log(`connectable: ${list.length} / ${latest.size} | official: ${list.filter((s) => s.official).length}`);
console.log('by kind:', by);
