// MCP 可接入服务器目录 — zero-dependency Node server (built-in http + node:sqlite).
// Run: node server.mjs   (PORT env to override, default 8787)
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, normalize, extname } from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONNECTABLE_PATH = new URL('./data/connectable.json', import.meta.url);
// The raw text is served as-is to avoid re-serialising per request; LIST is the parsed copy used
// for stats and id validation.
// shortcut: ~5.9MB uncompressed, no pagination — add gzip or a field projection when this goes public.
const CONNECTABLE = existsSync(CONNECTABLE_PATH) ? readFileSync(CONNECTABLE_PATH, 'utf8') : '[]';
const LIST = JSON.parse(CONNECTABLE);
const IDS = new Set(LIST.map((s) => s.name));
// Stars come from data/repo-stars.json (GitHub GraphQL cache), keyed "owner/name"; connectable
// entries hold the full GitHub URL, so normalise before looking up.
const REPO_STARS = JSON.parse(readFileSync(new URL('./data/repo-stars.json', import.meta.url), 'utf8'));
const GH_REPO = /^https?:\/\/(?:www\.)?github\.com\//i;
const starsOf = (s) => (s.repo ? (REPO_STARS[s.repo.replace(GH_REPO, '').replace(/\.git$/i, '')]?.stars ?? 0) : 0);
// Liveness of remote endpoints, from scripts/probe-status.mjs. Absent = never probed.
const STATUS_PATH = new URL('./data/status.json', import.meta.url);
const STATUS = existsSync(STATUS_PATH) ? JSON.parse(readFileSync(STATUS_PATH, 'utf8')).results : {};

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
const db = new DatabaseSync(new URL('./data/app.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
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
const RATING_PRIOR_WEIGHT = 5; // phantom reviews pulling the average toward 3.5
const RATING_PRIOR_VALUE = 3.5;
// Engagement is normalised against a fixed target, not the observed maximum, so one vote can no
// longer hand the first server the full 25 points. 50 weighted votes (like 1, favorite 2) = full marks.
const ENGAGEMENT_FULL = 50;
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
    if (stars || engagement || reviews) {
      const bayes = ((st.ratingSum ?? 0) + RATING_PRIOR_WEIGHT * RATING_PRIOR_VALUE) / (reviews + RATING_PRIOR_WEIGHT);
      const starScore = stars ? Math.log10(stars + 1) / Math.log10(MAX_STARS + 1) : 0;
      const engagementScore = Math.min(1, Math.log10(engagement + 1) / Math.log10(ENGAGEMENT_FULL + 1));
      // 没有评价就不给评分项留 30%，权重全给星标——否则所有人都白拿 21 分，名次差异被压扁。
      // 两种情况的权重和都是 1，综合分上限始终是 100。
      const starsWeight = reviews ? 0.45 : 0.75;
      const score = 100 * (starsWeight * starScore + (reviews ? 0.3 * (bayes / 5) : 0) + 0.25 * engagementScore);
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
const throttled = (ip) => {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 40;
};

// ---- API -------------------------------------------------------------------
const handleApi = async (req, res, url, visitorId) => {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = req.method === 'POST' ? await readBody(req) : null;
  if (req.method === 'POST' && throttled(req.socket.remoteAddress ?? '?')) {
    return fail(res, 429, '操作太频繁，请稍后再试');
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return json(res, 200, { ...buildStats(visitorId), status: STATUS });
  }

  if (req.method === 'GET' && url.pathname === '/api/connectable') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(CONNECTABLE);
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

  return fail(res, 404, 'unknown endpoint');
};

// ---- static ----------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const serveStatic = (req, res, pathname) => {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel === '' ? 'index.html' : rel);
  if (!normalize(file).startsWith(normalize(PUBLIC_DIR))) return fail(res, 403, 'forbidden');
  if (!existsSync(file)) return fail(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
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
