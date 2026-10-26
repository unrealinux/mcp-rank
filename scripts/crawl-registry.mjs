// Crawl the official MCP Registry into data/raw-registry.jsonl (one server per line).
// Also maintains data/first-seen.json (name → first-date-seen), which drives the 新上架 badge
// and the 最近上架 filter. First run after this change seeds every known name with null
// (unknown epoch — no badge until a name shows up in a later crawl).
// Run: node scripts/crawl-registry.mjs
import { createWriteStream, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
const SEEN_PATH = 'data/first-seen.json';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 400);
const out = createWriteStream('data/raw-registry.jsonl');
await mkdir('data', { recursive: true });

// Seen-map pacing: absence of the file means the pre-新上架 era, so existing names get null.
const seed = !existsSync(SEEN_PATH);
const seen = seed ? {} : JSON.parse(readFileSync(SEEN_PATH, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
let newNames = 0;

let cursor = '';
let page = 0;
let total = 0;
while (page < MAX_PAGES) {
  const url = `${BASE}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  for (const s of body.servers ?? []) {
    out.write(JSON.stringify(s) + '\n');
    const name = s.server?.name;
    if (name && !(name in seen)) {
      seen[name] = seed ? null : today; // 首次 seeding 不盖章；后续爬取才发现的名字才记上架日
      if (!seed) newNames++;
    }
  }
  total += body.servers?.length ?? 0;
  page++;
  cursor = body.metadata?.nextCursor ?? '';
  if (page % 10 === 0) console.error(`page ${page} total ${total}`);
  if (!cursor) break;
}
out.end();
writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 1));
console.error(`done: ${page} pages, ${total} records, ${newNames} new names → ${SEEN_PATH}`);
