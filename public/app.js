// 可接入 MCP 列表前端。
// /api/connectable —— 全量静态列表（13k 条，5.9MB），只拉一次。
// /api/stats      —— 每条的分数/点赞/评分（只有有信号的条目），投票后只需重拉这个。
const $ = (sel) => document.querySelector(sel);
const CAP = 300; // DOM 行数上限，超过必须靠搜索缩小
const state = { list: [], stats: {}, status: {}, q: '', kind: 'all', sort: 'hot', current: null, rating: 0 };

const api = async (path, init) => {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
  return body;
};

const stars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const endpoint = (s) => (s.connect.kind === 'stdio' ? `${s.connect.command} ${s.connect.args.join(' ')}` : s.connect.url);

// ---- 广告位 -----------------------------------------------------------------
// 内容在 public/ads.js 里填，留空则显示招租占位。
const ADS = window.ADS ?? {};

function fillAd(el, slot) {
  const html = String(ADS[slot] ?? '').trim();
  const tag = document.createElement('span');
  tag.className = 'ad-tag';
  tag.textContent = '广告';
  const box = document.createElement('div');
  box.className = 'ad-body';
  if (html) box.innerHTML = html; // 受信任的静态内容，见 ads.js 注释
  else {
    box.classList.add('vacant');
    box.textContent = '广告位招租 —— 面向 MCP 开发者的横幅 / 文字链';
  }
  el.replaceChildren(tag, box);
  el.hidden = false;
}

const adRow = (slot) => {
  const li = document.createElement('li');
  li.className = 'ad-slot inline';
  fillAd(li, slot);
  return li;
};

// 固定位置的两块在脚本加载时就填，数据拉取失败也照样出广告。
fillAd($('#ad-top'), 'top');
fillAd($('#ad-footer'), 'footer');

const copyText = async (text, btn) => {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制';
  } catch { btn.textContent = '复制失败'; }
  setTimeout(() => (btn.textContent = '复制'), 1200);
};

const rows = () => state.list.map((s) => ({ ...s, ...(state.stats[s.name] ?? {}) }));

// Liveness badge for remote endpoints; stdio entries are not probed and get no badge.
const BADGE = {
  ok: ['✅ 已验证', 'tag ok'],
  auth: ['🔑 需密钥', 'tag warn'],
  error: ['❌ 失联', 'tag bad'],
  dead: ['❌ 失联', 'tag bad'],
};
const badgeOf = (name) => BADGE[state.status[name]?.status];

function visible() {
  const q = state.q.trim().toLowerCase();
  const list = rows().filter((s) => {
    if (state.kind === 'remote' && s.connect.kind !== 'remote') return false;
    if (state.kind === 'stdio' && s.connect.kind !== 'stdio') return false;
    if (state.kind === 'official' && !s.official) return false;
    if (state.kind === 'verified' && state.status[s.name]?.status !== 'ok') return false;
    if (state.kind === 'mine' && !s.myVotes?.length && !s.myReview) return false;
    if (!q) return true;
    return [s.title, s.name, s.description, s.repo].some((v) => (v ?? '').toLowerCase().includes(q));
  });
  const by = {
    hot: (a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.stars ?? 0) - (a.stars ?? 0),
    stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
    rating: (a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0) || (b.reviewCount ?? 0) - (a.reviewCount ?? 0),
    likes: (a, b) => (b.likes ?? 0) + 2 * (b.favorites ?? 0) - ((a.likes ?? 0) + 2 * (a.favorites ?? 0)),
    name: (a, b) => a.title.localeCompare(b.title),
  };
  return list.sort(by[state.sort]);
}

function card(s) {
  const li = document.createElement('li');
  li.className = 'card';

  const mid = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.append(s.title);
  for (const [text, cls] of [
    [s.connect.kind === 'remote' ? s.connect.type : s.connect.kind, 'tag'],
    ...(badgeOf(s.name) ? [badgeOf(s.name)] : []),
    ...(s.official ? [['官方', 'tag gold']] : []),
  ]) {
    const tag = document.createElement('span');
    tag.className = cls;
    tag.textContent = text;
    title.append(tag);
  }

  const ep = document.createElement('div');
  ep.className = 'c-ep compact';
  const code = document.createElement('code');
  code.textContent = endpoint(s);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = '复制';
  copy.onclick = (e) => { e.stopPropagation(); copyText(endpoint(s), copy); };
  ep.append(code, copy);

  const summary = document.createElement('p');
  summary.className = 'summary';
  summary.textContent = s.description || '（官方未提供说明）';

  const meta = document.createElement('div');
  meta.className = 'meta';
  for (const text of [
    s.stars ? `★ ${stars(s.stars)}` : null,
    `${s.reviewCount ?? 0} 条评价${s.avgRating ? ` · ${s.avgRating}/5` : ''}`,
    `👍 ${s.likes ?? 0}　⭐ ${s.favorites ?? 0}`,
  ].filter(Boolean)) {
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  }
  if (s.repo) {
    const a = document.createElement('a');
    a.href = s.repo;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = s.repo.replace(/^https:\/\/github\.com\//, '');
    meta.append(a);
  }

  const votes = document.createElement('div');
  votes.className = 'votes';
  for (const kind of ['like', 'favorite']) {
    const btn = document.createElement('button');
    const on = (s.myVotes ?? []).includes(kind);
    btn.className = 'vote';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = `${kind === 'like' ? '👍 点赞' : '⭐ 收藏'} ${s[kind === 'like' ? 'likes' : 'favorites'] ?? 0}`;
    btn.onclick = (e) => { e.stopPropagation(); vote(s.name, kind, !on); };
    votes.append(btn);
  }

  mid.append(title, ep, summary, meta, votes);

  const right = document.createElement('div');
  right.className = 'score';
  right.append(s.score == null ? '—' : String(s.score));
  const small = document.createElement('small');
  small.textContent = '综合分';
  right.append(small);

  li.append(mid, right);
  li.onclick = () => openDetail(s.name);
  return li;
}

function render() {
  const list = visible();
  const shown = list.slice(0, CAP);
  $('#count').textContent =
    `共 ${list.length} 条` + (list.length > CAP ? `，显示前 ${CAP} 条（输入关键词缩小范围）` : '') + `　/　全库 ${state.list.length} 条`;
  const nodes = shown.map(card);
  if (nodes.length > 3) nodes.splice(3, 0, adRow('inline'));
  $('#board').replaceChildren(...nodes);
  $('#empty').hidden = list.length > 0;
}

async function vote(id, kind, on) {
  try {
    await api(`/api/servers/${encodeURIComponent(id)}/vote`, { method: 'POST', body: JSON.stringify({ kind, on }) });
    await loadStats();
    if (state.current === id) await openDetail(id);
  } catch (err) { alert(err.message); }
}

function starRow() {
  $('#stars').replaceChildren(
    ...[1, 2, 3, 4, 5].map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'star';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.rating === n));
      b.setAttribute('aria-label', `${n} 分`);
      b.textContent = '★';
      b.onclick = () => { state.rating = n; starRow(); };
      return b;
    }),
  );
}

async function openDetail(id) {
  const s = rows().find((x) => x.name === id);
  if (!s) return;
  state.current = id;
  state.rating = s.myReview?.rating ?? 0;
  $('#d-title').textContent = s.title;
  $('#d-sub').textContent = `${s.connect.kind === 'remote' ? s.connect.type : s.connect.kind}　${s.score == null ? '暂无综合分' : `综合分 ${s.score}`}`;
  $('#d-summary').textContent = s.description || '（官方未提供说明）';

  const box = $('#d-connect');
  const code = document.createElement('code');
  code.textContent = endpoint(s);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = '复制';
  copy.onclick = () => copyText(endpoint(s), copy);
  box.replaceChildren(code, copy);

  const rowsHtml = [
    ['可用性', null, state.status[s.name] ? `${badgeOf(s.name)?.[0] ?? '❓ 未知'}　${new Date(state.status[s.name].at).toLocaleDateString('zh-CN')}` : '未检测'],
    ['Registry', `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(s.name)}`, s.name],
    ['GitHub', s.repo, s.repo ? s.repo.replace(/^https:\/\/github\.com\//, '') : null],
    ['官网', s.website, s.website],
    ['版本', null, s.version],
    ['星标', null, s.stars ? stars(s.stars) : null],
    ['用户评分', null, s.reviewCount ? `${s.avgRating} / 5（${s.reviewCount} 条）` : '暂无'],
  ];
  const info = $('#d-info');
  info.replaceChildren();
  for (const [label, href, text] of rowsHtml) {
    if (!text) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (href && /^https?:/.test(href)) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = text;
      dd.append(a);
    } else dd.textContent = text;
    info.append(dt, dd);
  }

  const myVotes = s.myVotes ?? [];
  $('#d-like').setAttribute('aria-pressed', String(myVotes.includes('like')));
  $('#d-like').textContent = `👍 点赞 ${s.likes ?? 0}`;
  $('#d-fav').setAttribute('aria-pressed', String(myVotes.includes('favorite')));
  $('#d-fav').textContent = `⭐ 收藏 ${s.favorites ?? 0}`;
  $('#review-text').value = s.myReview?.text ?? '';
  $('#review-msg').textContent = '';
  starRow();
  const dialog = $('#detail');
  if (!dialog.open) dialog.showModal();
  await loadReviews(id);
}

async function loadReviews(id) {
  const { reviews } = await api(`/api/servers/${encodeURIComponent(id)}/reviews`);
  $('#review-list').replaceChildren(
    ...reviews.map((r) => {
      const li = document.createElement('li');
      li.className = 'review';
      const head = document.createElement('div');
      head.className = 'head';
      head.textContent = `${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}　${r.mine ? '我的评价' : '匿名用户'}　${new Date(r.updatedAt).toLocaleDateString('zh-CN')}`;
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = r.text || '（只评分，未留言）';
      li.append(head, body);
      return li;
    }),
  );
}

async function loadStats() {
  const data = await api('/api/stats');
  state.stats = data.stats;
  state.status = data.status ?? {};
  render();
}

async function load() {
  const [list, stats] = await Promise.all([api('/api/connectable'), api('/api/stats')]);
  state.list = list;
  state.stats = stats.stats;
  state.status = stats.status ?? {};
  const probed = Object.keys(state.status).length;
  $('#meta').textContent = `数据更新：${new Date(stats.updatedAt).toLocaleString('zh-CN')}　接入可用性已抽检 ${probed} 条`;
  render();
}

$('#q').oninput = (e) => { state.q = e.target.value; render(); };
$('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
$('#kind').onchange = (e) => { state.kind = e.target.value; render(); };
$('#d-close').onclick = () => $('#detail').close();
$('#d-like').onclick = () => { const s = rows().find((x) => x.name === state.current); vote(s.name, 'like', !(s.myVotes ?? []).includes('like')); };
$('#d-fav').onclick = () => { const s = rows().find((x) => x.name === state.current); vote(s.name, 'favorite', !(s.myVotes ?? []).includes('favorite')); };
$('#review-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.rating) { $('#review-msg').textContent = '请先点星打分'; return; }
  try {
    await api(`/api/servers/${encodeURIComponent(state.current)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ rating: state.rating, text: $('#review-text').value }),
    });
    $('#review-msg').textContent = '已提交，谢谢！';
    await loadStats();
    await openDetail(state.current);
  } catch (err) { $('#review-msg').textContent = err.message; }
};

load().catch((err) => {
  $('#board').replaceChildren();
  $('#empty').hidden = false;
  $('#empty').textContent = err.message;
});
