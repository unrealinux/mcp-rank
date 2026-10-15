// Crawl the official MCP Registry into data/raw-registry.jsonl (one server per line).
// Run: node scripts/crawl-registry.mjs
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const BASE = 'https://registry.modelcontextprotocol.io/v0/servers';
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 400);
const out = createWriteStream('data/raw-registry.jsonl');
await mkdir('data', { recursive: true });

let cursor = '';
let page = 0;
let total = 0;
while (page < MAX_PAGES) {
  const url = `${BASE}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  for (const s of body.servers ?? []) out.write(JSON.stringify(s) + '\n');
  total += body.servers?.length ?? 0;
  page++;
  cursor = body.metadata?.nextCursor ?? '';
  if (page % 10 === 0) console.error(`page ${page} total ${total}`);
  if (!cursor) break;
}
out.end();
console.error(`done: ${page} pages, ${total} records`);
