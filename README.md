# dsh-deepseek-peak-pricing

DeepSeek 峰谷价格显示插件。定时同步官方「模型 & 价格」页的峰谷价格表，在**输入框左下角工具行**常驻一个徽标，显示当前时刻按高峰价还是谷时价计费；点击徽标向上弹出完整价格表、当前所处价格区间与切换倒计时。

```
┌ 输入框 ─────────────────────────────────────────┐
│                                                  │
│  +  📎   [权限] [Plan]  ● 谷时 ·18分              │  ← 本插件徽标
└──────────────────────────────────────────────────┘
        ↑ 点击后向上弹出面板
```

## 功能

| 能力 | 说明 |
|---|---|
| 定时同步 | 启动时（缓存超过 6 小时）与之后每 6 小时抓取官方价格页，解析后落盘到 `$DSH_HOME/storages/dsh-deepseek-peak-pricing/` |
| 常驻徽标 | 注册到 `conversation.input.left`，实时显示「高峰 / 谷时」；距切换 ≤ 60 分钟显示倒计时，≤ 10 分钟变成 `→高峰 8:12` 并圆点呼吸提示（阈值可配） |
| 上拉面板 | 点击徽标弹出：当前计费档位、距切换倒计时、北京时间与本地时间、按模型分列的高峰/谷时价格表、规则说明、数据来源与「立即刷新」 |
| 面板伸缩 | 拖动面板**右下角**可任意调整宽高；**双击标题栏**或点 `⤢` 放大到接近满屏，再点 `⤡` 还原。尺寸记在浏览器 localStorage 里，下次打开保持 |
| 离线兜底 | 从未联网也能用：内置 `lib/fallback.js` 快照；每次抓取失败都保留上一份可用数据并记录错误 |
| 节假日 | 内置 2025/2026 中国法定节假日表；可选配置节假日 API 联网补齐其他年份 |
| 语言 | **默认中文**（面板内所有说明文案）。`config.json` 的 `locale` 可选 `zh` / `en` / `auto`（`auto` 才跟随 DSH 语言设置，缺失时回退浏览器语言） |

## 峰谷规则

官方口径（价格页脚注 2）：

- **高峰**：北京时间**周一至周五** `09:00–12:00`、`14:00–18:00`，且**不含中国法定节假日**
- **空闲（谷时）**：其余全部时段，**包含周末与法定节假日全天**；价格为高峰价的一半
- **调休上班的周末仍按谷时计费**（官方明确"周末全天"），因此 `workdays` 只用于展示说明，不参与判定

实现要点：

- 规则由宿主半 `lib/schedule.js` 计算，客户端只做倒计时与渲染，**规则只有一份实现**
- 高峰窗口优先从官方脚注中**现场解析**（正则读 `HH:MM - HH:MM`）；页面改版解析不到时回退到官方默认窗口，并在面板上以 `rules.source` 区分
- 时区固定 `Asia/Shanghai`（北京自 1991 年起无夏令时，固定 +08:00 精确）
- 节假日表内置 2025/2026（来源：国务院办公厅相应年度放假安排通知）。**跨年需要更新一次**，或配置 `holidayApiUrl` 联网补齐

## 安装

这是一个 DSH **bundle 插件**：包内 `cordis.patch.yml` 声明一行宿主插件入口，profile 的 `dsh.profile.bundles` 引用本包名即可挂载。

### 安装到 desktop（Electron）profile

Electron 托管的 `desktop` profile 不能用 `dsh plugin --profile desktop` 管理，需要手工两步（`<插件目录>` 为本仓库中的 `deepseek-peak-pricing` 绝对路径）：

1. 编辑 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-better-sidebar",
        "dsh-deepseek-peak-pricing"   // ← 追加到 bundles
      ]
    }
  },
  "dependencies": {
    "dsh-better-sidebar": "^0.24.1",
    "dsh-deepseek-peak-pricing": "link:<插件目录>"   // ← 本地链接
  }
}
```

2. 在 profile 目录安装链接：

```sh
cd ~/.dsh/profiles/desktop
pnpm install
```

3. **重启 DeepSeek Harness**：宿主插件入口与客户端 bundle 都在启动时装载/快照，热重载不覆盖它们。

### 验证安装

```sh
# 宿主路由：应返回 ok:true 与当前价格档位
curl -s http://127.0.0.1:19387/deepseek-pricing/api/state | head -c 400
```

界面侧：重启后任意会话的输入框左下角出现「谷时 / 高峰」徽标。

## 配置（可选）

所有配置都可省略。在数据目录写 `config.json`：

```jsonc
// ~/.dsh/storages/dsh-deepseek-peak-pricing/config.json
{
  "refreshIntervalHours": 6,          // 同步周期，默认 6 小时
  "fetchTimeoutMs": 20000,            // 单次抓取超时
  "pricingUrls": [                    // 依次尝试，先成功者生效
    "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    "https://api-docs.deepseek.com/quick_start/pricing"
  ],
  "holidayApiUrl": null,              // 例：https://timor.tech/api/holiday/year/{year}
  "locale": "zh",                     // zh（默认）| en | auto（跟随 DSH 语言设置）
  "badgeCountdownMinutes": 60,        // 距切换多少分钟内，徽标开始显示倒计时
  "badgeUrgentMinutes": 10            // 距切换多少分钟内，徽标变成「→高峰 m:ss」并呼吸提示
}
```

`holidayApiUrl` 中的 `{year}` 会被替换为年份（取当前年前后各一年）；兼容 `timor.tech` 的 `{ holiday: { "01-01": { holiday: true, name: "元旦" } } }` 结构。抓取失败只记录告警，内置表继续生效。

`locale` 只接受 `zh` / `en` / `auto`，其余值回落为 `zh`；两个分钟数会被夹到 `1–240`，并保证 "紧急窗口 ≤ 倒计时窗口"（写反了也能正常工作）。改完配置需重启应用。

## 结构

```
deepseek-peak-pricing/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml      # 宿主入口 insert 行
├── lib/
│   ├── index.js          # 宿主半：同步、持久化、路由（/deepseek-pricing/api/*）
│   ├── parse.js          # 官方价格页 → 结构化快照（纯函数，重建 rowspan/colspan 表格）
│   ├── schedule.js       # 峰谷规则与倒计时（纯函数）
│   ├── holidays.js       # 中国法定节假日表 + 远程 API 适配
│   ├── fallback.js       # 内置离线兜底快照（由脚本生成）
│   └── client.js         # 客户端半：__ModuleLoader__ factory bundle，只依赖 react
├── scripts/build-fallback.mjs   # 从 fixture 重新生成 fallback.js
└── test/                 # node:test 单测（解析 / 规则 / 宿主路由 / 客户端 bundle 冒烟）
```

技术选择说明：

- **客户端半是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle**，不需要构建工具；DSH 只从基线模块表解析 `react`
- **宿主 ↔ 客户端走 `ctx.webServer.register` 的只读 JSON 路由**（`dsh-better-sidebar` 的成熟做法），客户端只 `fetch` 同源路径，不触碰文件与网络
- 路由带 DNS-rebinding / 跨站防护：Host 必须是 loopback 或受信主机，`sec-fetch-site: cross-site` 与跨站 `Origin` 一律 403
- 宿主半**零依赖**（仅 node 内置模块），因此以 `link:` 方式挂载到 profile 时无需在插件目录安装任何 `node_modules`

## 开发与测试

```sh
cd deepseek-peak-pricing
node --test test/*.test.mjs          # 42 项：解析、峰谷规则、节假日、宿主路由、客户端渲染
node scripts/build-fallback.mjs      # 打印当前 fixture 解析结果（干跑）
node scripts/build-fallback.mjs test/fixtures/pricing.zh.html --write   # 重新生成兜底快照
```

`test/fixtures/pricing.zh.html` 是官方价格页的存档副本。**官方改版时先更新该 fixture，再跑测试**——`parse.test.mjs` 会立刻指出形状变化。

## 故障排查

| 现象 | 处理 |
|---|---|
| 重启后没有徽标 | 确认 `dsh.profile.bundles` 含本包名、`pnpm install` 已执行、`~/.dsh/profiles/desktop/node_modules/dsh-deepseek-peak-pricing` 链接存在；再看应用日志中的 `[dsh-deepseek-peak-pricing]` 行 |
| 面板显示「内置兜底数据」 | 抓取失败（离线/代理）。面板会展示 `lastError` 原文，点「立即刷新」重试 |
| 面板出现「解析告警」 | 官方页面结构或价格策略变化。若只是"谷时不是高峰一半"的告警，说明官方调价，价格仍按页面显示；若是"价格表无法解析"，请更新 fixture 与 `parse.js` |
| 节假日判定不对 | 内置表只覆盖 2025/2026。配置 `holidayApiUrl`，或按 `lib/holidays.js` 里的格式补充年份 |

## 已知限制

- 只反映**当前与之后**的计费档位，不回溯历史账单（不重算已发生费用）
- 节假日表随插件版本更新；未配置远程 API 时，新年度工作日会退化为"周一至周五全高峰"
- 官方价格页没有 JSON API，解析依赖 HTML 表格结构；已用 fixture 测试 + 兜底快照 + 告警三层层层兜底，但官方大改版仍需人工跟进
- 徽标挂在会话输入框内，因此只在会话界面可见（非会话页面不显示）

## 许可

MIT
