// 可接入 MCP 列表前端。
// /api/connectable?part=N —— 全量静态列表（13k 条，5.9MB），服务端切成 1000 条一片依次拉。
// （单次 5.9MB 在 Railway h2 边缘会卡死，必须分片。）
// /api/stats      —— 每条的分数/点赞/评分（只有有信号的条目），投票后只需重拉这个。
const $ = (sel) => document.querySelector(sel);
const CAP = 300; // DOM 行数上限，超过必须靠搜索缩小
const state = { list: [], stats: {}, status: {}, pkg: {}, q: '', kind: 'all', sort: 'hot', current: null, rating: 0 };

const api = async (path, init) => {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
  return body;
};

const stars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const endpoint = (s) => (s.connect.kind === 'stdio' ? `${s.connect.command} ${s.connect.args.join(' ')}` : s.connect.url);

// 一键 mcpServers 配置片段：站长口号是「能直接接进 Agent」，这里把最后一步也替用户走完。
const configSnippet = (s) => {
  const key = s.name.split('/').pop().replace(/[^A-Za-z0-9_-]/g, '-');
  const inner =
    s.connect.kind === 'remote' ? { url: s.connect.url } : { command: s.connect.command, args: s.connect.args };
  return JSON.stringify({ mcpServers: { [key]: inner } }, null, 2);
};

// 新上架 / 久未维护的时间阈值。
const NEW_MS = 14 * 86_400_000;
const STALE_MS = 365 * 86_400_000;

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
  const prev = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制';
  } catch { btn.textContent = '复制失败'; }
  setTimeout(() => (btn.textContent = prev), 1200);
};

// Merged view (list + stats). Worth caching: rebuilds 13k objects per call, which used to
// happen on every keystroke. Invalidated only when list or stats actually change.
let merged = null;
const rows = () => {
  if (!merged) merged = state.list.map((s) => ({ ...s, ...(state.stats[s.name] ?? {}) }));
  return merged;
};
const invalidateRows = () => (merged = null);

// ---- URL 同步 ------------------------------------------------------------------
// hash = #q=...&kind=...&sort=...&s=<name>。搜索/筛选/排序变化用 replaceState（不产生历史记录）；
// 打开详情 pushState（浏览器返回键可关弹窗），Esc/✕ 关闭时 history.back() 弹掉那条记录。
let booted = false;
let hashEntry = false; // 详情弹窗是否占用了一条历史记录
const KINDS = ['all', 'remote', 'stdio', 'verified', 'official', 'mine', 'recent'];
const SORTS = ['hot', 'stars', 'rating', 'likes', 'active', 'name'];
const parseHash = () => {
  const p = new URLSearchParams(location.hash.slice(1));
  const q = p.get('q') ?? '';
  const kind = KINDS.includes(p.get('kind')) ? p.get('kind') : 'all';
  const sort = SORTS.includes(p.get('sort')) ? p.get('sort') : 'hot';
  return { q, kind, sort, server: p.get('s') };
};
const hashStr = (server) => {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.kind !== 'all') p.set('kind', state.kind);
  if (state.sort !== 'hot') p.set('sort', state.sort);
  if (server) p.set('s', server);
  const qs = p.toString();
  return qs ? `#${qs}` : '#';
};
const replaceHash = (server) => history.replaceState(null, '', hashStr(server));
const hashHasServer = () => new URLSearchParams(location.hash.slice(1)).has('s');

// Liveness badge: remote 看探活结果，stdio 看包存在性，download 无实测。
const BADGE = {
  ok: ['✅ 已验证', 'tag ok'],
  auth: ['🔑 需密钥', 'tag warn'],
  error: ['❌ 失联', 'tag bad'],
  dead: ['❌ 失联', 'tag bad'],
};
const PKG_BADGE = { ok: ['📦 包在线', 'tag ok'], missing: ['📦 包已失效', 'tag bad'] };
const badgeOf = (s) => {
  if (s.connect.kind === 'stdio') return PKG_BADGE[state.pkg[s.name]?.status];
  if (s.connect.kind === 'remote') return BADGE[state.status[s.name]?.status];
  return null;
};
const freshTag = (s) => (s.since && Date.now() - new Date(s.since).getTime() < NEW_MS ? ['新上架', 'tag new'] : null);
const staleTag = (s) =>
  s.pushedAt && Date.now() - new Date(s.pushedAt).getTime() > STALE_MS ? ['久未维护', 'tag warn'] : null;

function visible() {
  const q = state.q.trim().toLowerCase();
  const list = rows().filter((s) => {
    if (state.kind === 'remote' && s.connect.kind !== 'remote') return false;
    if (state.kind === 'stdio' && s.connect.kind !== 'stdio') return false;
    if (state.kind === 'official' && !s.official) return false;
    if (state.kind === 'verified' && state.status[s.name]?.status !== 'ok') return false;
    if (state.kind === 'recent' && !(s.since && Date.now() - new Date(s.since).getTime() < 30 * 86_400_000)) return false;
    if (state.kind === 'mine' && !s.myVotes?.length && !s.myReview) return false;
    if (!q) return true;
    return [s.title, s.name, s.description, s.repo].some((v) => (v ?? '').toLowerCase().includes(q));
  });
  const by = {
    hot: (a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.stars ?? 0) - (a.stars ?? 0),
    stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
    rating: (a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0) || (b.reviewCount ?? 0) - (a.reviewCount ?? 0),
    likes: (a, b) => (b.likes ?? 0) + 2 * (b.favorites ?? 0) - ((a.likes ?? 0) + 2 * (a.favorites ?? 0)),
    // 最近活跃：按仓库最后推送时间；无数据（未纳入 stats 的长尾）排最后。
    active: (a, b) => new Date(b.pushedAt ?? 0) - new Date(a.pushedAt ?? 0) || (b.stars ?? 0) - (a.stars ?? 0),
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
    ...(badgeOf(s) ? [badgeOf(s)] : []),
    ...(s.official ? [['官方', 'tag gold']] : []),
    ...(freshTag(s) ? [freshTag(s)] : []),
    ...(staleTag(s) ? [staleTag(s)] : []),
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
  // 键盘可达：卡片本质是「打开详情」的按钮，Tab 能到、Enter/空格能触发。
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', `${s.title}，查看详情`);
  li.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDetail(s.name);
    }
  };
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
  if (booted) replaceHash(state.current);
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

async function openDetail(id, push = true) {
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
  // .mcpb 下载包没有 config 结构，只给 endpoint 复制。
  if (s.connect.kind !== 'download') {
    const cfg = document.createElement('button');
    cfg.type = 'button';
    cfg.className = 'copy';
    cfg.textContent = '复制配置';
    cfg.onclick = () => copyText(configSnippet(s), cfg);
    box.append(cfg);
  }

  const availability = () => {
    if (s.connect.kind === 'stdio') {
      const p = state.pkg[s.name];
      return p ? `${PKG_BADGE[p.status]?.[0] ?? '❓ 未知'}　${new Date(p.at).toLocaleDateString('zh-CN')}` : '未检测';
    }
    if (s.connect.kind === 'remote') {
      return state.status[s.name]
        ? `${badgeOf(s)?.[0] ?? '❓ 未知'}　${new Date(state.status[s.name].at).toLocaleDateString('zh-CN')}`
        : '未检测';
    }
    return null;
  };
  const staleHint = (staleTag(s) ? '　⚠️ 超 1 年未推送' : '');
  const rowsHtml = [
    ['可用性', null, availability()],
    ['最近更新', null, s.pushedAt ? `${new Date(s.pushedAt).toLocaleDateString('zh-CN')}${staleHint}` : null],
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
  $('#review-delete').hidden = !s.myReview;
  starRow();
  const dialog = $('#detail');
  if (!dialog.open) {
    dialog.showModal();
    // 弹窗首次打开：push 一条历史记录（浏览器返回键=关闭弹窗）；已在弹窗中的刷新无需再 push。
    if (push) {
      hashEntry = true;
      history.pushState(null, '', hashStr(id));
    }
  } else if (!hashHasServer()) {
    replaceHash(id);
  }
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
  state.pkg = data.pkg ?? {};
  invalidateRows();
  render();
}

// 首屏只要第一批（1000 条）就够渲染 300 行，剩下的分片后台补齐后才供搜索使用。
async function load() {
  const [first, stats] = await Promise.all([api('/api/connectable?part=0'), api('/api/stats')]);
  state.list = first;
  state.stats = stats.stats;
  state.status = stats.status ?? {};
  state.pkg = stats.pkg ?? {};
  invalidateRows();
  const probed = Object.keys(state.status).length;
  $('#meta').textContent = `数据更新：${new Date(stats.updatedAt).toLocaleString('zh-CN')}　接入可用性已抽检 ${probed} 条`;
  render();
  fillRest();
}

async function fillRest() {
  // 4 路并发：中国到 sjc1 单请求 ~1s RTT，串行拉 13 片要 30s。
  let next = 1;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      let part;
      try {
        part = await api(`/api/connectable?part=${i}`);
      } catch {
        return; // 后台补齐失败就保持首批可用的状态，搜索范围变小但不影响浏览
      }
      if (!part.length) return;
      state.list = state.list.concat(part);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  invalidateRows();
  render();
}

// ---- 事件与启动 ---------------------------------------------------------------
// 首次进入先把 hash 里的筛选状态套到控件上，深链/分享的 URL 一次到位。
Object.assign(state, parseHash());
delete state.server;
$('#q').value = state.q;
$('#sort').value = state.sort;
$('#kind').value = state.kind;

// Debounced: each keystroke used to rebuild merged rows + up to 300 cards.
let qTimer;
$('#q').oninput = (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = e.target.value;
    render();
  }, 150);
};
$('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
$('#kind').onchange = (e) => { state.kind = e.target.value; render(); };
$('#d-close').onclick = () => $('#detail').close();

// ⓧ 按钮和 Esc 都走这里。弹窗用 push 占过一条历史，就 back 弹掉；否则只清 hash。
$('#detail').addEventListener('close', () => {
  state.current = null;
  if (hashEntry) {
    hashEntry = false;
    history.back(); // popstate 里会自然落到「弹窗已关」的分支
  } else {
    replaceHash();
  }
});

// 前进/后退（含返回键关弹窗）：以 hash 为准重算筛选与弹窗。
window.addEventListener('popstate', () => {
  if (!booted) return;
  const h = parseHash();
  if (h.q !== state.q || h.kind !== state.kind || h.sort !== state.sort) {
    state.q = h.q;
    state.kind = h.kind;
    state.sort = h.sort;
    $('#q').value = state.q;
    $('#sort').value = state.sort;
    $('#kind').value = state.kind;
    render();
  }
  // 弹窗已关（Esc/✕ 路径的 back 落到这里）时对齐 state；close 事件通常已把它清空。
  if (!$('#detail').open) state.current = null;
  const found = h.server && rows().find((x) => x.name === h.server);
  if (found && h.server !== state.current) {
    openDetail(h.server, false); // 历史记录已有这条 URL，不再 push
  } else if (!found && state.current && $('#detail').open) {
    $('#detail').close();
  }
});

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
$('#review-delete').onclick = async (e) => {
  e.preventDefault();
  try {
    await api(`/api/servers/${encodeURIComponent(state.current)}/reviews`, { method: 'DELETE' });
    $('#review-msg').textContent = '已删除我的评价。';
    state.rating = 0;
    await loadStats();
    await openDetail(state.current);
  } catch (err) { $('#review-msg').textContent = err.message; }
};

load()
  .then(() => {
    booted = true;
    const h = parseHash();
    if (h.server) {
      if (rows().find((x) => x.name === h.server)) openDetail(h.server, false); // 直达深链：不再加历史记录
      else replaceHash(); // 无效 server id：丢弃 s 参数
    } else {
      replaceHash(); // 归一化（去掉不认识的参数）
    }
  })
  .catch((err) => {
    $('#board').replaceChildren();
    $('#empty').hidden = false;
    $('#empty').textContent = err.message;
  });
