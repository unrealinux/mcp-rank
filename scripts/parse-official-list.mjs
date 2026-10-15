// Parse the VoltAgent/official-mcp-servers README (a curated official list) into
// data/official-list.json: [{ category, label, url, repo, description }].
// Input: data/voltagent-readme.md  Run: node scripts/parse-official-list.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync('data/voltagent-readme.md', 'utf8');
const rows = [];
let category = null;

for (const line of md.split('\n')) {
  const summary = /<summary>.*?>(.*?)<\/summary>/.exec(line);
  if (summary) {
    category = summary[1].replace(/<[^>]*>/g, '').trim();
    continue;
  }
  const entry = /^- \*\*\[([^\]]+)\]\(([^)]+)\)\*\*(?:\s*-\s*(.*?))?\s*(?:\(\[Claude\]\([^)]*\)\))?\s*$/.exec(line);
  if (!entry || !category) continue;
  const [, label, url, description = ''] = entry;
  const repo = /github\.com\/([^/\s)]+)\/([^/\s)#]+)/i.exec(url)?.slice(1, 3).join('/').replace(/\.git$/i, '') ?? null;
  rows.push({ category, label, url, repo, description: description.replace(/\(\[Claude\]\([^)]*\)\)/g, '').trim() });
}

const byCategory = {};
for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
writeFileSync('data/official-list.json', JSON.stringify(rows, null, 1));
console.log(`entries: ${rows.length}, with github repo: ${rows.filter((r) => r.repo).length}`);
for (const [c, n] of Object.entries(byCategory)) console.log(` ${String(n).padStart(3)}  ${c}`);
