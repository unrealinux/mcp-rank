// Merge the curated official list with registry metadata + GitHub stars.
// Output: data/catalog.json  Run: node scripts/build-catalog.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const official = JSON.parse(readFileSync('data/official-list.json', 'utf8'));
const registry = JSON.parse(readFileSync('data/servers.json', 'utf8'));
const stars = JSON.parse(readFileSync('data/repo-stars.json', 'utf8'));

const norm = (r) => r?.toLowerCase().replace(/\.git$/, '');
const byRepo = new Map();
for (const s of registry) {
  if (!s.repo || s.namespace.startsWith('ai.smithery')) continue;
  const key = norm(s.repo);
  const score = (s.namespace.startsWith('io.github.') ? 0 : 10) + (s.remoteCount > 0 ? 1 : 0);
  const prev = byRepo.get(key);
  if (!prev || score > prev.score) byRepo.set(key, { score, server: s });
}

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Fallback for vendors that publish only a hosted server: match the label against the
// LAST namespace segment ("Notion" -> com.notion/mcp, "Linear" -> app.linear/linear).
// Hosting namespaces like app.vercel.<app> put the vendor in the middle, so they miss.
const byVendor = new Map();
for (const s of registry) {
  if (s.namespace.startsWith('io.github.') || s.namespace.startsWith('ai.smithery')) continue;
  const vendor = s.namespace.split('.').at(-1);
  if (vendor.length < 3) continue;
  const score = s.remoteCount * 10 + (s.packageTypes.length ? 1 : 0);
  if (score === 0) continue;
  const best = byVendor.get(vendor);
  if (!best || score > best.score) byVendor.set(vendor, { score, server: s });
}

const seen = new Set();
const catalog = [];
for (const o of official) {
  const match = (o.repo ? byRepo.get(norm(o.repo))?.server : null)
    ?? byVendor.get(slug(o.label))?.server
    ?? null;
  const id = slug(o.label) || slug(match?.name ?? o.url);
  if (seen.has(id)) continue;
  seen.add(id);
  const stat = o.repo ? stars[o.repo] : null;
  catalog.push({
    id,
    label: o.label,
    category: o.category,
    summary: o.description || match?.description || '',
    repo: o.repo,
    repoUrl: o.repo ? `https://github.com/${o.repo}` : null,
    docsUrl: o.repo ? null : o.url,
    registryName: match?.name ?? null,
    remotes: match?.remotes ?? [],
    install: match ? { remotes: match.remoteTypes, packages: match.packageTypes, version: match.version } : null,
    stars: stat?.stars ?? null,
    forks: stat?.forks ?? null,
    pushedAt: stat?.pushedAt ?? null,
    icon: match?.icon ?? null,
  });
}

writeFileSync('data/catalog.json', JSON.stringify(catalog, null, 1));
const withStars = catalog.filter((c) => c.stars != null);
const withRegistry = catalog.filter((c) => c.registryName);
console.log(`catalog: ${catalog.length} | with stars: ${withStars.length} | in registry: ${withRegistry.length}`);
console.log('duplicate ids dropped:', official.length - catalog.length);
