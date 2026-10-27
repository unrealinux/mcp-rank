// MCP 可接入服务器目录 — zero-dependency Node server (built-in http + node:sqlite).
// Run: node server.mjs   (PORT env to override, default 8787)
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { scoreOf } from './lib/rank.mjs';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, dirname } from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
// fileURLToPath, not .pathname: .pathname keeps percent-encoding, which breaks any non-ASCII
// directory (e.g. 文档) for SQLite and path joins. The manual Windows-drive strip is handled too.
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const CONNECTABLE_PATH = new URL('./data/connectable.json', import.meta.url);
// The raw text is served as-is to avoid re-serialising per request; LIST is the parsed copy used
// for stats and id validation.
// shortcut: ~5.9MB uncompressed, no pagination — add gzip or a field projection when this goes public.
const CONNECTABLE = existsSync(CONNECTABLE_PATH) ? readFileSync(CONNECTABLE_PATH, 'utf8') : '[]';
const LIST = JSON.parse(CONNECTABLE);
const IDS = new Set(LIST.map((s) => s.name));
// The list is frozen until restart, so compress and hash it once at startup: every request
// then serves a cached buffer, and browsers with a matching If-None-Match get a 304.
const CONNECTABLE_GZ = gzipSync(Buffer.from(CONNECTABLE));
const CONNECTABLE_ETAG = `"${createHash('sha1').update(CONNECTABLE).digest('hex')}"`;
// Served in parts: Railway's h2 edge stalls a single multi-MB body before it reaches Chrome,
// so /api/connectable?part=N is the only form the browser actually receives. Each part is
// pre-serialised and pre-gzipped at startup — no per-request work.
const PART_SIZE = 1000;
const PARTS = Array.from({ length: Math.ceil(LIST.length / PART_SIZE) }, (_, i) => {
  const body = Buffer.from(JSON.stringify(LIST.slice(i * PART_SIZE, (i + 1) * PART_SIZE)));
  return { gz: gzipSync(body), raw: body };
});
// Stars come from data/repo-stars.json (GitHub GraphQL cache), keyed "owner/name"; connectable
// entries hold the full GitHub URL, so normalise before looking up.
const REPO_STARS = JSON.parse(readFileSync(new URL('./data/repo-stars.json', import.meta.url), 'utf8'));
const GH_REPO = /^https?:\/\/(?:www\.)?github\.com\//i;
const repoKey = (s) => s.repo?.replace(GH_REPO, '').replace(/\.git$/i, '') ?? null;
const starsOf = (s) => REPO_STARS[repoKey(s)]?.stars ?? 0;
const pushedAtOf = (s) => REPO_STARS[repoKey(s)]?.pushedAt ?? null;
// Liveness of remote endpoints, from scripts/probe-status.mjs. Absent = never probed.
const STATUS_PATH = new URL('./data/status.json', import.meta.url);
const STATUS = existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, 'utf8')).results : {};
// stdio package existence, from scripts/probe-packages.mjs (npm/pypi/nuget/crates registry checks).
const PKG_PATH = new URL('./data/pkg-status.json', import.meta.url);
const PKGS = existsSync(PKG_PATH) ? JSON.parse(readFileSync(PKG_PATH, 'utf8')).results : {};

// 数据库落点：本地默认 ./data/app.db；Railway 之类平台的文件系统是易失的，
// 挂载持久卷到别的路径（如 /appdata）后用 DB_PATH 指过去即可。
const DB_PATH = process.env.DB_PATH ?? fileURLToPath(new URL('./data/app.db', import.meta.url));
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS votes (
    server_id TEXT NOT NULL, visitor_id TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (server_id, visitor_id, kind)
  );
  CREATE TABLE IF NOT EXISTS reviews (
    server_id TEXT NOT NULL, visitor_id TEXT NOT NULL, rating INTEGER NOT NULL,
    text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (server_id, visitor_id)
  );
  CREATE INDEX IF NOT EXISTS reviews_by_server ON reviews (server_id);
`);

// ---- ranking ---------------------------------------------------------------
// 公式与常量在 lib/rank.mjs（带单测）；这里只算依赖全量列表的派生量 MAX_STARS。
const MAX_STARS = Math.max(1, ...LIST.map(starsOf));

const statsByServer = () => {
  const like = db.prepare(`SELECT server_id, COUNT(*) n FROM votes WHERE kind='like' GROUP BY server_id`).all();
  const fav = db.prepare(`SELECT server_id, COUNT(*) n FROM votes WHERE kind='favorite' GROUP BY server_id`).all();
  const rev = db.prepare(`SELECT server_id, COUNT(*) n, AVG(rating) avg, SUM(rating) sum FROM reviews GROUP BY server_id`).all();
  const map = new Map();
  for (const r of like) map.set(r.server_id, { ...(map.get(r.server_id) ?? {}), likes: r.n });
  for (const r of fav) map.set(r.server_id, { ...(map.get(r.server_id) ?? {}), favorites: r.n });
  for (const r of rev) map.set(r.server_id, { ...(map.get(r.server_id) ?? {}), reviews: r.n, ratingSum: r.sum });
  return map;
};

// Only entries with a signal (stars, votes or reviews) get a score, which keeps the payload small.
const buildStats = (visitorId) => {
  const stats = statsByServer();
  const myVotes = db.prepare('SELECT server_id, kind FROM votes WHERE visitor_id = ?').all(visitorId);
  const myReviews = db.prepare('SELECT server_id, rating, text FROM reviews WHERE visitor_id = ?').all(visitorId);
  const mine = {};
  for (const v of myVotes) (mine[v.server_id] ??= { votes: [] }).votes.push(v.kind);
  for (const r of myReviews) (mine[r.server_id] ??= { votes: [] }).review = { rating: r.rating, text: r.text };

  const rows = {};
  for (const s of LIST) {
    const st = stats.get(s.name) ?? {};
    const stars = starsOf(s);
    const reviews = st.reviews ?? 0;
    const likes = st.likes ?? 0;
    const favorites = st.favorites ?? 0;
    const engagement = likes + 2 * favorites;
    const row = { stars, likes, favorites, reviewCount: reviews };
    // pushedAt is free from the repo-stars cache; powers the 最近活跃 sort and 弃坑 hint.
    const pushedAt = pushedAtOf(s);
    if (pushedAt) row.pushedAt = pushedAt;
    if (stars || engagement || reviews) {
      // 没有评价就不给评分项留 30%，权重全给星标——否则所有人都白拿 21 分，名次差异被压扁。
      // 两种情况的权重和都是 1，综合分上限始终是 100。公式实现见 lib/rank.mjs。
      const score = scoreOf({ stars, starsMax: MAX_STARS, reviews, ratingSum: st.ratingSum, likes, favorites });
      row.score = Number(score.toFixed(1));
      row.avgRating = reviews ? Number(((st.ratingSum ?? 0) / reviews).toFixed(2)) : null;
    }
    Object.assign(row, mine[s.name]);
    if (row.score != null || row.myVotes || row.myReview) rows[s.name] = row;
  }
  return { updatedAt: new Date().toISOString(), total: LIST.length, stats: rows };
};

// ---- request helpers -------------------------------------------------------
const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
};
const fail = (res, code, message) => json(res, code, { error: message });

const readBody = (req, limit = 8192) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });

const VISITOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identify = (req, res) => {
  const raw = /(?:^|;\s*)vid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const existing = VISITOR_RE.test(raw) ? raw : null;
  const vid = existing ?? randomUUID();
  res.setHeader('Set-Cookie', `vid=${vid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  return vid;
};

// Write throttle: 40 writes / minute / IP. Cheap in-memory sliding window.
const hits = new Map();
// Behind a reverse proxy every visitor shares one socket address; opt in with TRUST_PROXY=1
// (only safe if the proxy actually sets X-Forwarded-For).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ipOf = (req) => {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '?';
};
const throttled = (ip) => {
  const now = Date.now();
  // Timestamps are appended in order, so the last element is the newest. Table only ever
  // grows, so prune stale IPs once it gets large instead of waiting for each to revisit.
  if (hits.size > 10_000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] >= 60_000) hits.delete(k);
    }
  }
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  if (!recent.length) hits.delete(ip);
  else hits.set(ip, recent);
  return recent.length > 40;
};

// ---- API -------------------------------------------------------------------
const handleApi = async (req, res, url, visitorId) => {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = req.method === 'POST' ? await readBody(req) : null;
  if (req.method === 'POST' && throttled(ipOf(req))) {
    return fail(res, 429, '操作太频繁，请稍后再试');
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return json(res, 200, { ...buildStats(visitorId), status: STATUS, pkg: PKGS });
  }

  if (req.method === 'GET' && url.pathname === '/api/connectable') {
    const part = url.searchParams.get('part');
    if (part !== null) {
      if (!/^[0-9]+$/.test(part)) return fail(res, 400, 'part must be a non-negative integer');
      const chunk = PARTS[Number(part)];
      // out-of-range int 仍返回空数组：客户端把空片当作“拉完”的信号，不能 400。
      if (!chunk) return json(res, 200, []);
      const gz = String(req.headers['accept-encoding'] ?? '').includes('gzip');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'Accept-Encoding',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      });
      return res.end(gz ? chunk.gz : chunk.raw);
    }
    if (req.headers['if-none-match'] === CONNECTABLE_ETAG) {
      res.writeHead(304, { ETag: CONNECTABLE_ETAG });
      return res.end();
    }
    const gz = String(req.headers['accept-encoding'] ?? '').includes('gzip');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      Vary: 'Accept-Encoding',
      ETag: CONNECTABLE_ETAG,
      // Not no-store: the payload is static until restart, so revalidation via ETag is cheap.
      'Cache-Control': 'no-cache',
      ...(gz ? { 'Content-Encoding': 'gzip', 'Content-Length': CONNECTABLE_GZ.length } : {}),
    });
    return res.end(gz ? CONNECTABLE_GZ : CONNECTABLE);
  }

  if (req.method === 'GET' && parts[1] === 'servers' && parts[3] === 'reviews') {
    const id = decodeURIComponent(parts[2]);
    if (!IDS.has(id)) return fail(res, 404, 'server not found');
    const rows = db
      .prepare('SELECT visitor_id, rating, text, updated_at FROM reviews WHERE server_id = ? ORDER BY updated_at DESC LIMIT 100')
      .all(id);
    return json(res, 200, {
      reviews: rows.map((r) => ({
        rating: r.rating,
        text: r.text,
        updatedAt: r.updated_at,
        mine: r.visitor_id === visitorId,
      })),
    });
  }

  if (req.method === 'POST' && parts[1] === 'servers' && parts[3] === 'vote') {
    const id = decodeURIComponent(parts[2]);
    if (!IDS.has(id)) return fail(res, 404, 'server not found');
    const kind = body?.kind;
    if (kind !== 'like' && kind !== 'favorite') return fail(res, 400, 'kind must be like or favorite');
    const on = body?.on === true;
    if (on) db.prepare('INSERT OR IGNORE INTO votes (server_id, visitor_id, kind) VALUES (?,?,?)').run(id, visitorId, kind);
    else db.prepare('DELETE FROM votes WHERE server_id = ? AND visitor_id = ? AND kind = ?').run(id, visitorId, kind);
    const n = db.prepare('SELECT COUNT(*) n FROM votes WHERE server_id = ? AND kind = ?').get(id, kind).n;
    return json(res, 200, { serverId: id, kind, on, count: n });
  }

  if (req.method === 'POST' && parts[1] === 'servers' && parts[3] === 'reviews') {
    const id = decodeURIComponent(parts[2]);
    if (!IDS.has(id)) return fail(res, 404, 'server not found');
    const rating = Number(body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(res, 400, '评分必须是 1-5 的整数');
    const text = typeof body?.text === 'string' ? body.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
    if (text.length > 1000) return fail(res, 400, '评价最多 1000 字');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO reviews (server_id, visitor_id, rating, text, created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (server_id, visitor_id) DO UPDATE SET rating=excluded.rating, text=excluded.text, updated_at=excluded.updated_at`,
    ).run(id, visitorId, rating, text, now, now);
    return json(res, 200, { serverId: id, rating, text });
  }

  if (req.method === 'DELETE' && parts[1] === 'servers' && parts[3] === 'reviews') {
    const id = decodeURIComponent(parts[2]);
    if (!IDS.has(id)) return fail(res, 404, 'server not found');
    db.prepare('DELETE FROM reviews WHERE server_id = ? AND visitor_id = ?').run(id, visitorId);
    return json(res, 200, { serverId: id, deleted: true });
  }

  return fail(res, 404, 'unknown endpoint');
};

// ---- static ----------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const serveStatic = (req, res, pathname) => {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel === '' ? 'index.html' : rel);
  if (!normalize(file).startsWith(normalize(PUBLIC_DIR))) return fail(res, 403, 'forbidden');
  if (!existsSync(file)) return fail(res, 404, 'not found');
  // no-cache + must-revalidate: 没有这两个头 Chrome 会启发式缓存旧 app.js，改完前端看不到变化。
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const visitorId = identify(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, visitorId);
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(req.method, url.pathname, err.message);
    if (!res.headersSent) fail(res, err.message === 'body too large' ? 413 : 400, err.message);
  }
}).listen(PORT, () => console.log(`MCP 目录 → http://localhost:${PORT}  (${LIST.length} servers, ${Object.keys(REPO_STARS).length} repos cached)`));
