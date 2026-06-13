# Sub2API Upstream Console

一个独立的 Sub2API 上游聚合控制台，用来集中查看多个上游账号的余额、用量、倍率、充值比例和同步状态。

当前版本：`v1.7.0`

## 项目定位

这个项目不修改任何上游 Sub2API 中转站，也不嵌入上游项目本体。它是一个外部管理控制台：

1. 在本控制台录入多个上游地址和凭证。
2. 后端代表你登录或调用上游统一接口。
3. 数据保存到本地 SQLite，形成余额、用量、倍率和充值配置快照。
4. 前端只展示整理后的结果，不暴露完整密码、Token 或上游原始 payload。

## 快速开始

```powershell
npm install
npm start
```

默认访问：

```text
http://localhost:4317
```

更多说明：

- [需求文档](docs/PRD_CN.md)
- [部署说明](docs/DEPLOY_CN.md)
- [备份说明](docs/BACKUP_CN.md)
- [模型广场价格 TODO](docs/MODEL_PRICING_TODO_CN.md)
- [代办清单](TODO_CN.md)

## 当前功能

### 上游管理

- 新增、编辑、删除上游站点。
- 新增上游类型选择，支持 `自动识别`、`Sub2API`、`new-api`。
- 支持账号密码、Token、管理员 Token 等接入模式。
- 上游账号密码和 Token 本地加密保存。
- 支持标签、备注、Codex 倍率别名、低余额阈值和同步频率配置。
- 支持连接测试、停用/启用上游、一键复制上游地址。

### 同步和监控

- 手动同步单个上游或全部上游。
- 后台按上游同步频率自动同步。
- 展示余额、今日/近 7 天/近 30 天用量、成本、API Key 数量、渠道数量和分组倍率。
- 对 `new-api` 上游支持读取用户订阅摘要，包括订阅状态、计费偏好、到期时间、总额度、已用额度、剩余额度和使用百分比。
- 对 `new-api` 上游支持读取模型广场官方倍率，优先使用 `/api/pricing`，并可用 `/api/ratio_config` 兜底。
- 对 `sub2api` 上游支持读取 `openai` / `anthropic` 分组倍率，并按官方原价换算成模型实际价格。
- 保存历史快照，展示余额和用量趋势。
- 记录同步日志、最近成功时间、最近失败原因。
- 支持低余额、长期未同步、同步失败和倍率变化提醒。

### 倍率聚合

- 聚合展示所有上游最新分组倍率。
- 每条倍率卡片明确标出所属上游。
- 支持按关键词搜索倍率分组。
- 倍率筛选保留 `全部倍率`、`OpenAI`、`Anthropic`。
- 支持倍率变化记录和确认。

### 充值换算

- 基于 Wei-Shaw/sub2api 统一支付接口读取充值配置。
- 优先调用 `/api/v1/payment/checkout-info`，并兼容 `/payment/config` 与 `/payment/plans`。
- 展示 `balance_recharge_multiplier` 对应的充值比例，例如 `1 RMB = 10 余额/刀`。
- 展示手续费率和可售套餐数量。
- 上游未开放支付接口或余额充值关闭时，展示为不可用/已关闭，不猜测充值页面。

### 安全和生产化

- 可选控制台登录密码。
- 前端不返回完整密码，不返回上游原始响应 payload。
- 账号邮箱在详情接口中脱敏。
- 支持配置导入/导出，导出默认不带密码。
- 支持 SQLite 数据库备份。
- 基础 SSRF 防护，阻止 localhost、内网和 metadata 地址。
- 支持 Sub2API `/api/v1` 与 `/api` 路径兜底。
- 支持 QuantumNous/new-api 的 `/api/user/login`、`/api/user/self`、`/api/user/self/groups`、`/api/token/`、`/api/log/self/stat` 和 `/api/subscription/self` 等接口。

### API Key 聚合管理

- 跨上游查看所有 Sub2API Key 列表（名称、掩码、分组、平台、状态、配额、最后使用时间）。
- 在本控制台直接创建 Key：选上游 → 选分组（OpenAI / Anthropic 等）→ 填名称即可。
- 创建成功后一次性展示完整 Key，支持复制；本地加密保存创建记录。
- 支持启用/停用、删除 Key；上游详情页提供「在此上游创建 Key」快捷入口。
- 模型价格广场仅展示重点监控模型（GPT-5.4/5.5、指定 Claude 型号）。

### 前端体验

- 上游列表支持搜索、标签筛选、状态筛选和排序。
- 深色/浅色主题切换。
- 移动端布局适配。
- 关键数字区域使用 `Times New Roman` 显示，便于阅读余额、倍率和用量。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4317` | 服务端口 |
| `DATABASE_PATH` | `./data/upstream-console.sqlite` | SQLite 数据库路径 |
| `APP_SECRET` | `dev-only-change-me` | 上游凭证加密密钥，生产环境必须更换 |
| `ADMIN_PASSWORD` | 空 | 控制台登录密码；为空时本地开发免登录 |
| `SESSION_SECRET` | 复用 `APP_SECRET` | 登录 Cookie 签名密钥 |
| `SYNC_SCHEDULER_ENABLED` | `true` | 是否启用后台定时同步 |
| `SYNC_SCHEDULER_TICK_SECONDS` | `30` | 后台同步扫描间隔 |
| `MAX_SYNC_LOGS` | `500` | 每个上游保留的同步日志数量 |
| `MAX_RATE_SNAPSHOTS` | `2000` | 每个上游保留的倍率快照数量 |

## 更新说明

### v1.7.0 - 2026-06-13

- 新增「API Key 管理」首页板块，跨上游查看、创建、启停和删除 Sub2API Key。
- 新增 `src/upstreamKeys.js` 与 `/api/upstream-keys`、`/api/upstreams/:id/keys`、`/api/upstreams/:id/key-groups` 等接口。
- 创建 Key 时通过分组下拉选择 OpenAI / Claude 等线路，无需逐个登录上游网站。
- 新增 `upstream_api_key_snapshots` 和 `upstream_key_create_logs` 表，同步时保存 Key 快照，创建时加密保存完整密钥。
- 模型价格广场增加监控白名单，OpenAI 仅展示 GPT-5.4 / GPT-5.5，Claude 仅展示指定型号。
- 修复 `public/app.js` 编码损坏导致的页面白屏问题。

### v1.6.0 - 2026-06-10

- 新增“模型价格广场”首页板块，固定分成 `OpenAI 模型` 和 `Claude 模型` 两个区域。
- 按 QuantumNous/new-api 前端源码公式计算价格：输入价 `model_ratio * 2 * group_ratio`，输出价再乘 `completion_ratio`。
- 每个模型卡片顶部明确标注“官方原价”，并在下方列出各上游叠加分组倍率后的实际输入/输出价格。
- 模型价格广场相关价格数字统一使用 `Times New Roman` 字体，便于区分官方原价与上游实际价格。
- 新增 `src/modelPricing.js` 价格计算模块和 `/api/model-pricing/board` 聚合接口，用于按厂商板块聚合模型价格。
- `model_pricing_snapshots` 增加官方价、上游实际价、实际分组和分组倍率字段。
- 支持将 `sub2api` 上游的 `openai` / `anthropic` 分组倍率直接乘到官方原价上，补全首页与详情页的模型实际价格展示。
- 上游详情页的“模型广场价格”区块会优先展示换算后的输入/输出价格，并标注命中的分组与倍率。

### v1.5.0 - 2026-06-10

- 接入 QuantumNous/new-api 模型广场接口 `/api/pricing`，同步模型名、供应商、标签、端点类型、启用分组、模型倍率、补全倍率、缓存倍率、固定价格和 pricing version。
- 新增 `model_pricing_snapshots` 本地快照表，并在当前快照中保存 `pricing_summary`，用于展示模型数量、供应商数量、倍率范围和 Codex 相关模型最低倍率。
- 上游详情页新增“模型广场倍率”区块，展示模型广场摘要和前 30 个模型的官方倍率。
- 增加 `/api/model-pricing` 聚合接口，后续可基于该接口继续做跨上游同模型倍率对比。
- 同步日志增加 `modelPricing=数量`，方便确认该上游是否成功同步模型广场。

### v1.4.1 - 2026-06-10

- 按 QuantumNous/new-api 源码适配 `/api/subscription/self` 订阅结构，读取 `subscriptions` 活跃订阅和 `all_subscriptions` 全部订阅数量。
- 上游列表新增“订阅”列，显示 `活跃 / 全部` 数量，例如 `1 / 1`。
- new-api 订阅详情新增 Active / Total 和 Next Reset 展示，并兼容仅返回全部订阅时自动计算活跃数量。
- 同步 `package-lock.json` 项目版本号，避免 npm 元数据仍停留在旧版本。

### v1.4.0 - 2026-06-09

- 新增“上游类型”下拉框，可选择自动识别、Sub2API 或 new-api，并按选择强制使用对应同步协议。
- 接入 QuantumNous/new-api 上游，支持账号密码登录、余额、用量、Key 数量、分组倍率和订阅摘要同步。
- 在上游详情页展示 new-api 订阅信息，包括订阅 ID、套餐/计划 ID、状态、计费偏好、剩余天数、到期时间、总额度、已用额度、剩余额度和使用百分比。
- 修复局部编辑上游时默认值覆盖问题，避免只修改一个字段时把上游类型重置为 `auto`。

### v1.3.1 - 2026-06-08

- 重写 README 结构，按能力模块展示当前功能、环境变量和版本说明。
- 修正文档中倍率筛选项描述，使其与当前页面的 OpenAI、Anthropic 筛选一致。
- 优化关键数字区域字体，统一使用 `Times New Roman`。

### v1.3.0 - 2026-06-08

- 接入 Wei-Shaw/sub2api 统一支付接口，采集上游充值比例、手续费率和可售套餐数量。
- 在上游列表、详情页和能力矩阵展示充值换算能力。
- 优化“当前分组倍率”聚合区，明确展示每条倍率所属上游。
- 倍率筛选项精简为全部、OpenAI、Anthropic。

### v1.2.0 - 2026-06-08

- 增加配置导入/导出和数据库备份入口。
- 增加上游详情页、能力矩阵、历史趋势和更多筛选。
- 增加 SSRF 防护、倍率变化确认、上游停用/启用。

## 开发检查

```powershell
npm test
```

`npm test` 当前会执行 dry-run，确认模块加载和基础配置可用。
