# 可接入的 MCP 服务器目录

13,779 个**能直接接进 Agent** 的公开 MCP server，每条给出接入地址或启动命令。
访客可以点赞、收藏、打分、写评价。

## 跑起来

```bash
node scripts/export-connectable.mjs   # 首次：从 raw-registry.jsonl 生成列表
node server.mjs                       # → http://localhost:8787
PORT=3000 node server.mjs
```

零依赖：Node 内置 `http` + `node:sqlite`。不需要 `npm install`。要求 Node ≥ 22.5（自带的 `node:sqlite`）。

## 列表里有什么

每条要么是 **remote**（给出可直连的 `streamable-http` / `sse` URL），要么是 **stdio**
（给出 `npx` / `uvx` / `docker` / `dnx` / `cargo` 启动命令），要么是 **.mcpb** 下载包。
既没有 remote 也没有包的记录不收录。

来源是 MCP 官方 Registry 全量抓取，**不做社区/垃圾过滤**——只标记了哪些属于厂商官方。

## 数据来源

| 数据 | 来源 |
|---|---|
| 接入地址、版本、包类型 | [MCP 官方 Registry](https://registry.modelcontextprotocol.io/) 全量（13,862 个 server 的最新版） |
| 厂商官方标记 | [VoltAgent/official-mcp-servers](https://github.com/VoltAgent/official-mcp-servers) 人工精选 296 条，按仓库/命名空间对齐 |
| 星标 | GitHub GraphQL（缓存在 `data/repo-stars.json`，5,593 个仓库） |
| 接入可用性 | 实测：向每条 remote 地址发一次 MCP `initialize`（`data/status.json`） |
| 用户数据 | 本站 SQLite（`data/app.db`） |

## 综合分

```
有评价： 综合分 = 100 × ( 0.45 × stars对数归一 + 0.30 × 评分贝叶斯均值 + 0.25 × 点赞收藏对数归一 )
无评价： 综合分 = 100 × ( 0.75 × stars对数归一 + 0.25 × 点赞收藏对数归一 )
```

- **没有评价的条目不给 30% 评分项留空分**，权重全部并到星标。否则 13,000 多条无评价的条目人人都白拿 21 分，名次差距被压扁。两种情况的权重和都是 1，综合分上限始终是 100。
- **贝叶斯评分**：`(总星数 + 5 × 3.5) / (评价数 + 5)`，5 条以内的评价会被拉回 3.5，避免 1 个人打 5 星就冲榜。
- **互动项固定分母**：`log10(互动+1) / log10(51)`，50 次权重互动（点赞 1、收藏 2）拿满 25 分。早期投票不会因为「全场最高分就是它」而被放大。
- 只有**有信号**（有星标 / 有互动）的条目才进 `/api/stats`，其余显示「—」。当前有分的是 2,016 条。
- 冷启动时用户项为 0，榜单退化成 GitHub 星标榜。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/connectable` | 全量列表（13,779 条，约 5.9MB），静态缓存，不含用户数据 |
| GET | `/api/stats` | 每条服务器的分数 / 星标 / 点赞 / 评分，当前访客自己的投票与评价，以及 `status` 探活结果 |
| GET | `/api/servers/:id/reviews` | 最近 100 条评价 |
| POST | `/api/servers/:id/vote` | `{ kind: "like" \| "favorite", on: boolean }` |
| POST | `/api/servers/:id/reviews` | `{ rating: 1-5, text: "≤1000 字" }`，同一访客重复提交即覆盖 |

`:id` 用 Registry 名称，例如 `com.browser-use/browser-use`（URL 里要 `encodeURIComponent`）。

访客身份是一个服务端下发的 `HttpOnly` cookie（`vid`），没有登录。

## 刷数据

```bash
GH_TOKEN=$(gh auth token) node scripts/refresh.mjs
node scripts/export-connectable.mjs   # 改完 Registry 数据后要重跑，否则列表是旧的
```

`refresh.mjs` 依次跑：抓 Registry → 生成 `data/servers.json` → 补齐 GitHub stars（带缓存，只拉新增）→ 生成 `data/catalog.json`（官方 296 条）。约 10 分钟（Registry 约 400 页）。改完重启 `server.mjs`。

探活（可重复跑，已探过的会跳过，只拉新增）：

```bash
npm run probe          # 默认前 500 名，约 10 分钟
node scripts/probe-status.mjs 2000
```

状态含义：`ok` 握手成功；`auth` 返回 401/403，需自备 API key；`error` 返回其他 HTTP 状态；`dead` 超时或连接失败。跳过带 `{占位符}` 的 URL。并发固定为 4——调高会把本地连接数打满，报出假的超时。

## 广告位

三处：头部横幅（`top`）、列表第 3 条下方（`inline`）、列表底部（`footer`）。
填 `public/ads.js` 里的字符串即可上线，留空显示招租占位。

```js
window.ADS = {
  top: '<a href="https://example.com"><img src="/sponsor.png" alt="赞助商"></a>',
  inline: '',
  footer: '',
};
```

只放自己写的 HTML——这段是直接 `innerHTML` 进页面的，别把用户输入或第三方脚本塞进去。

## 已知取舍

- **绝大部分条目没人用过**：13,779 条里只有 2,016 条有星标或互动，长尾全在「—」区。榜单实际只在前几百名里有意义。
- **只探了 257 条（前 500 名里有 remote 地址的那部分）**：其中 56 条可直接握手（22%）、123 条要密钥（48%）、32 条报错、46 条无响应。其余 13,500 多条没测，前端显示为「未检测」。
- **stdio（2,140 条）完全未探活**：只确认 Registry 有登记，没验证 npm/PyPI 上的包还在不在。
- **官方标记只覆盖 49 / 13,779**：VoltAgent 那 296 条里，多数厂商只发 npm 包或文档，和 Registry 记录对不上。
- **列表接口 5.9MB 未压缩、无分页**：上公网前要加 gzip 或字段裁剪；前端也只渲染前 300 条。
- **星标第一名会被评价拖累一点**：星标权重从 0.75 掉到 0.45 后，一条 5 星评价只能补回 `0.3 × 贝叶斯/5`。对星标不是全场最高的条目，好评总是加分；只有榜一（星标项满值 1.0）会因权重被挪走而小幅下降（实测 75 → 71.9）。
- **反滥用较弱**：只有一个 IP 维度的滑动窗口限流（40 次写/分钟）+ 一访客一服务器一评价。公开部署前应加 Turnstile 之类的验证。
- **单进程 SQLite**：适合单机或小流量；要多实例得换 Postgres。
