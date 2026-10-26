# 可接入的 MCP 服务器目录

13,779 个**能直接接进 Agent** 的公开 MCP server，每条给出接入地址或启动命令。
访客可以点赞、收藏、打分、写评价（可删除自己的评价）；搜索、筛选、评价与详情弹窗都支持 URL 分享。

## 跑起来

```bash
node scripts/export-connectable.mjs   # 首次：从 raw-registry.jsonl 生成列表
node server.mjs                       # → http://localhost:8787
PORT=3000 node server.mjs
```

零依赖：Node 内置 `http` + `node:sqlite`。不需要 `npm install`。要求 Node ≥ 22.5（自带的 `node:sqlite`）。

```bash
npm test   # lib/rank.mjs 的综合分公式单测
```

## 列表里有什么

每条要么是 **remote**（给出可直连的 `streamable-http` / `sse` URL），要么是 **stdio**
（给出 `npx` / `uvx` / `docker` / `dnx` / `cargo` 启动命令），要么是 **.mcpb** 下载包。
既没有 remote 也没有包的记录不收录。

来源是 MCP 官方 Registry 全量抓取，**不做社区/垃圾过滤**——只标记了哪些属于厂商官方。stdio 条目还会实测包还在不在（`npm run probe:pkgs`）。

## 数据来源

| 数据 | 来源 |
|---|---|
| 接入地址、版本、包类型 | [MCP 官方 Registry](https://registry.modelcontextprotocol.io/) 全量（13,862 个 server 的最新版） |
| 厂商官方标记 | [VoltAgent/official-mcp-servers](https://github.com/VoltAgent/official-mcp-servers) 人工精选 296 条，按仓库/命名空间对齐 |
| 星标 | GitHub GraphQL（缓存在 `data/repo-stars.json`，5,593 个仓库；缓存带 `fetchedAt`，7 天以上重刷，旧格式缓存首次运行全量回填） |
| 接入可用性 | 实测：向每条 remote 地址发一次 MCP `initialize`（`data/status.json`） |
| stdio 包存在性 | 实测：查 npm / PyPI / NuGet / crates.io registry（`data/pkg-status.json`，docker 不查） |
| 上架日期 | Registry 抓取时记录名字首次出现日（`data/first-seen.json`；补种前的旧条目为 null，无「新上架」标记） |
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
| GET | `/api/connectable` | 全量列表（13,779 条），启动时预压缩，带 ETag：命中则返回 304；gzip 后约 1.1MB，无分页，不含用户数据 |
| GET | `/api/stats` | 每条服务器的分数 / 星标 / 评分 / `pushedAt` 仓库最后推送，当前访客自己的投票与评价，以及 `status` 探活和 `pkg` 包存在性结果 |
| GET | `/api/servers/:id/reviews` | 最近 100 条评价 |
| POST | `/api/servers/:id/vote` | `{ kind: "like" \| "favorite", on: boolean }` |
| POST | `/api/servers/:id/reviews` | `{ rating: 1-5, text: "≤1000 字" }`，同一访客重复提交即覆盖 |
| DELETE | `/api/servers/:id/reviews` | 删除当前访客对该服务器的评价 |

`:id` 用 Registry 名称，例如 `com.browser-use/browser-use`（URL 里要 `encodeURIComponent`）。

访客身份是一个服务端下发的 `HttpOnly` cookie（`vid`），没有登录。

## 刷数据

```bash
GH_TOKEN=$(gh auth token) node scripts/refresh.mjs
node scripts/export-connectable.mjs   # 改完 Registry 数据后要重跑，否则列表是旧的
```

`refresh.mjs` 依次跑：抓 Registry → 生成 `data/servers.json` → 补齐 GitHub stars（带缓存，7 天以上重刷）→ 生成 `data/catalog.json`（官方 296 条）。约 10 分钟（Registry 约 400 页）。首次在本次改动后跑，`data/first-seen.json` 会把现存条目全部记为 null（无「新上架」标记），此后爬取新发现的名字才记上架日。改完重启 `server.mjs`。

探活（可重复跑，30 天内探过的跳过，其余重探——「已验证」始终表示最近结果）：

```bash
npm run probe                    # 默认星标前 500 名，日限额 300 条
node scripts/probe-status.mjs 2000 800   # 探到第 2000 名，单次最高 800 条
```

玩法：放进 cron 每天跑一次，300 条/天的日限额按星标次序推进，约 6 周覆盖全部 11,549 个 remote URL，之后靠 30 天 TTL 持续保鲜。官方条目在每日批次里永远置顶，不会被限额饿死。

状态含义：`ok` 握手成功；`auth` 返回 401/403，需自备 API key；`error` 返回其他 HTTP 状态；`dead` 超时或连接失败。跳过带 `{占位符}` 的 URL。并发固定为 4——调高会把本地连接数打满，报出假的超时。

stdio 包存在性（npm / PyPI / NuGet / crates.io 各查一次，docker 镜像不查）：

```bash
npm run probe:pkgs               # 默认日限额 400 条
node scripts/probe-packages.mjs 5000 800
```

结果在 `data/pkg-status.json`：`ok` registry 上有这个包；`missing` 404，包已删；`unknown` 网络/限流拿不到明确答案（不覆盖旧状态）。同样带 30 天 TTL，均可 cron 驱动。

## 部署（Railway / 任意 Node 平台）

`railway.json` 已配好 Nixpacks 构建 + `npm start`，推到 GitHub 后在 Railway「New Project → Deploy from GitHub repo」即可，无需额外配置。

上线前在 Railway 里加两样东西：

1. **持久卷**（Volume）：挂到如 `/appdata`，再设环境变量 `DB_PATH=/appdata/app.db`——否则每次重新部署都会清空点赞/收藏/评价（SQLite 在易失磁盘上）。
2. **`TRUST_PROXY=1`**：Railway 的边缘代理在最前面，`X-Forwarded-For` 可信；不设的话所有访客共享同一个限流窗口（40 次写/分钟会集体触发）。

数据更新流程不变：本地跑 `refresh` / `probe` / `probe:pkgs` → 提交更新后的 `data/*.json` → push 自动触发重新部署（静态数据随镜像走，不需要运行时写入）。`GH_TOKEN` 只在本地刷数据时需要，运行时不需要。

内存预估：启动时全量载入 + 预压缩 5.9MB 列表，常驻约 100-150MB，Railway 默认 512MB 够用。

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
- **探活覆盖低但可自动扩**：目前只有约 257 条 remote 实测过（56 可直连 / 123 要密钥 / 32 报错 / 46 无响应）。把 `npm run probe` 放 cron，300 条/天约 6 周覆盖全部 11,549 个 remote，之后靠 30 天 TTL 保鲜。
- **stdio 包存在性已有验证管线**：`npm run probe:pkgs` 查 npm/PyPI/NuGet/crates.io（docker 不查），400 条/天约一周扫完 2,140 条 stdio，跑过才显示「📦 包在线 / 包已失效」。
- **官方标记只覆盖 49 / 13,779**：VoltAgent 那 296 条里，多数厂商只发 npm 包或文档，和 Registry 记录对不上。
- **列表接口 gzip 后约 1.1MB、无分页**：上公网前可再做字段裁剪；前端也只渲染前 300 条。
- **星标第一名会被评价拖累一点**：星标权重从 0.75 掉到 0.45 后，一条 5 星评价只能补回 `0.3 × 贝叶斯/5`。对星标不是全场最高的条目，好评总是加分；只有榜一（星标项满值 1.0）会因权重被挪走而小幅下降（实测 75 → 71.9）。
- **反滥用较弱**：只有一个 IP 维度的滑动窗口限流（40 次写/分钟）+ 一访客一服务器一评价。放反向代理后面需加 `TRUST_PROXY=1`（按 `X-Forwarded-For` 取访客 IP，前提是代理确实设置该头），否则所有访客共享限流窗口。公开部署前还应加 Turnstile 之类的验证。
- **单进程 SQLite**：适合单机或小流量；要多实例得换 Postgres。
