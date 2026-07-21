# Sub2API Upstream Console

一个独立的 Sub2API 上游运维控制台，用来集中查看上游余额、Key 分组倍率、真实联通性、异常事件和同步状态。

当前版本：`v1.8.0`

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

## 生产部署与在线更新

推荐使用 Node.js 22、Git 和 systemd 部署。源码、环境配置、运行数据分别存放，后续更新不会覆盖密钥或 SQLite：

```text
/opt/sub2api-upstream-console/       Git 源码
/etc/sub2api-upstream-console.env    生产环境变量
/var/lib/sub2api-upstream-console/   SQLite 数据
/var/backups/sub2api-upstream-console/ 更新前备份
```

生产环境至少配置：

```env
PORT=6060
DATABASE_PATH=/var/lib/sub2api-upstream-console/upstream-console.sqlite
APP_SECRET=固定的强随机字符串
SESSION_SECRET=另一个固定的强随机字符串
ADMIN_PASSWORD=控制台登录密码
SELF_UPDATE_ENABLED=true
SELF_UPDATE_REMOTE=origin
SELF_UPDATE_BRANCH=main
UPDATE_BACKUP_DIR=/var/backups/sub2api-upstream-console
```

`APP_SECRET` 用于加密上游凭证和完整 Key，投入使用后不能随版本更新而更换。`.env` 和数据库必须放在 Git 工作区之外，并限制文件权限。

仓库提供 [systemd 服务示例](deploy/sub2api-upstream-console.service)。服务用户需要对源码目录、`.git`、`node_modules`、数据目录和备份目录拥有写权限，systemd 必须设置 `Restart=always`。

首次部署并启动成功后，可以在“设置 → 系统 → 系统版本”中检查和安装更新。在线更新仅允许从配置好的 `origin/main` 快进：

1. 检查服务器工作区，存在未提交修改或分支分叉时拒绝更新。
2. 使用 SQLite 在线备份 API 创建更新前备份。
3. 更新源码并执行 `npm ci --omit=dev`。
4. 运行完整 `npm test`；失败时自动恢复原提交和依赖。
5. 测试通过后退出，由 systemd 拉起新版，前端等待恢复后自动刷新。

在线更新不能替代服务器备份。建议定期把数据库备份复制到另一台主机或对象存储。没有域名和 HTTPS 时，不要把控制台长期暴露给所有公网来源；至少应设置强 `ADMIN_PASSWORD` 并在云防火墙限制访问 IP。

更多说明：

- [需求文档](docs/PRD_CN.md)
- [部署说明](docs/DEPLOY_CN.md)
- [备份说明](docs/BACKUP_CN.md)
- [API Key 绑定分组展示需求](docs/API_KEY_GROUP_DISPLAY_REQUIREMENT_CN.md)
- [自己站观测与上游路由映射需求](docs/OWN_SITE_OBSERVABILITY_REQUIREMENT_CN.md)
- [UI 重构构思](docs/UI_REDESIGN_PLAN_CN.md)
- [模型广场价格 TODO](docs/MODEL_PRICING_TODO_CN.md)
- [代办清单](TODO_CN.md)

## 当前功能

### 上游管理

- 新增、编辑、删除上游站点。
- 新增上游类型选择，支持 `自动识别`、`Sub2API`、`new-api`。
- 支持账号密码、Token、管理员 Token 等接入模式。
- 上游账号密码和 Token 本地加密保存。
- 支持标签、备注、低余额阈值和同步频率配置。
- 支持连接测试、停用/启用上游、一键复制上游地址。

### 同步和监控

- 新版上游监控台按余额优先展示，上游行可直接展开全部 Key。
- 支持单上游一键导入全部 Key：复用 Sub2API 前端请求中的 `X-User-UI-Request: 1` 语义获取完整 Key，并完整遍历分页。
- 完整 Key 使用 `APP_SECRET` 加密保存在本地，仅在后端调用上游时解密；API、日志和前端始终只返回掉码。
- 上游本次只返回掉码时不会覆盖已有密文；只有确认 Key 已从上游删除时才清理对应密文。
- 支持单 Key 和单上游全部 Key 真实请求检测，记录联通、超时、鉴权失败、额度不足、出口 IP 被拒绝、上游错误和耗时。
- 手动同步单个上游或全部上游。
- 后台按上游同步频率自动同步。
- 展示余额、今日/近 7 天/近 30 天用量、成本、API Key 数量、渠道数量和分组倍率。
- 上游列表按平台展示 **OpenAI / Anthropic 最低倍率**，直接读取 Sub2API 分组 `scope`，无需手动配置识别词。
- 对 `new-api` 上游支持读取用户订阅摘要，包括订阅状态、计费偏好、到期时间、总额度、已用额度、剩余额度和使用百分比。
- 对 `new-api` 上游支持读取模型广场官方倍率，优先使用 `/api/pricing`，并可用 `/api/ratio_config` 兜底。
- 对 `sub2api` / `auto` 上游支持读取 `openai` / `anthropic` 分组倍率，并按官方原价（或内置基准价）换算成模型实际价格。
- 保存历史快照，展示余额和用量趋势。
- 记录同步日志、最近成功时间、最近失败原因。
- 支持低余额、长期未同步、同步失败和倍率变化提醒。
- 支持 PushPlus 微信告警：可在设置页加密保存 Token，自定义事件开关、连续失败/恢复阈值、重复提醒、免打扰和恢复通知；默认把同一轮同一上游的多个 Key 异常合并成一条微信消息。
- 设置页集中管理通知规则、自动任务、上游策略和数据保留数量，保存后热生效，不需要重启进程。
- 全局自动同步/Key 探测可按上游覆盖；上游开关优先于全局默认，但环境变量硬停用始终优先。
- 告警页区分“待处理”“已处理”“已恢复”。标记已处理只停止该事故的重复提醒，只有真实联通恢复或同步恢复才会变成已恢复。

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

- Key 管理默认按上游折叠，展开后查看 Sub2API Key 名称、掩码、分组、平台、状态、倍率和联通性。
- 在本控制台直接创建 Key：选上游 → 选分组（OpenAI / Anthropic 等）→ 填名称即可。
- 创建成功后一次性展示完整 Key，支持复制；本地加密保存创建记录。
- 支持启用/停用、删除 Key；上游详情页提供「在此上游创建 Key」快捷入口。
- 支持手动同步分组检测模型，优先读取 `/v1/models`，不支持时使用近期真实使用记录作为候选。候选会持久化保留到下次手动同步，单个分组同步失败不会清空旧缓存。
- 上游监控和 Key 管理都可为每个 Key 选择独立检测模型，生效优先级为 `Key 选择 > 分组选择 > 平台默认模型`。
- OpenAI GPT / Codex 模型优先使用 `/v1/responses`，其他 OpenAI 模型优先使用 `/v1/chat/completions`，Anthropic 使用 `/v1/messages`；只有明确的端点不兼容才会尝试备用协议。
- 模型价格广场仅展示重点监控模型（GPT-5.4/5.5、指定 Claude 型号）。

### 上游使用明细

- 从选中的 Sub2API 上游实时读取逐请求记录，不在本地长期保存敏感日志。
- 支持按日期、Key、分组、模型和请求类型筛选，并使用上游分页。
- 展示 Token、实际费用、倍率和延迟；IP、User-Agent、请求 ID 等放在请求详情中。
- 后端只返回白名单字段，完整 Key、账号凭证和上游原始对象不会下发到浏览器。

### 自己站观测

- 新增「自己站观测」区块，可保存自己运营的中转站地址和凭证。
- 支持读取自己站 `/admin/accounts` 账号管理数据，展示每条账号接入的上游 API 地址、账号状态和自己站绑定分组。
- 支持手动把自己站账号绑定到本地已同步的上游 Key，用于确认这条账号实际使用哪条上游 Key。
- 支持进销倍率对账：`上游给我们` 取绑定上游 Key 的分组倍率，`我们卖出` 取自己站账号所在分组倍率，并显示倍率差。
- 匹配成功时展示上游名称、平台、采购倍率、售卖倍率和分组信息；匹配失败时显示具体原因。

### 前端体验

- 左侧导航的运维工作台，总览、上游监控、Key、自己站、模型价格、使用明细、告警和日志独立分区。
- 上游列表支持搜索、状态筛选、余额排序和展开 Key 明细。
- 深色/浅色主题切换。
- 移动端布局适配。
- 余额、倍率和联通耗时使用等宽数字排版，便于扫描比较。

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
| `KEY_CHECK_SCHEDULER_ENABLED` | `true` | 是否启用 Key 后台联通检测 |
| `KEY_CHECK_SCHEDULER_TICK_SECONDS` | `30` | Key 检测任务扫描间隔 |
| `KEY_CHECK_CONCURRENCY` | `3` | 单上游 Key 检测并发数 |
| `KEY_CHECK_TIMEOUT_MS` | `15000` | 单次真实请求超时时间 |
| `PUSHPLUS_TOKEN` | 空 | PushPlus Token 环境变量回退；设置页保存的 Token 优先 |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus/send` | PushPlus 推送接口 |
| `ALERT_FAILURE_THRESHOLD` | `3` | 连续失败多少次后开启事故 |
| `ALERT_RECOVERY_THRESHOLD` | `2` | 连续成功多少次后发送恢复 |
| `MAX_KEY_CHECK_LOGS` | `10000` | 每个上游保留的 Key 检测历史数量 |
| `MAX_SYNC_LOGS` | `500` | 每个上游保留的同步日志数量 |
| `MAX_RATE_SNAPSHOTS` | `2000` | 每个上游保留的倍率快照数量 |
| `SELF_UPDATE_ENABLED` | `false` | 是否启用设置页在线更新；仅应在 systemd/PM2 自动重启环境开启 |
| `SELF_UPDATE_REMOTE` | `origin` | 在线更新使用的固定 Git 远端 |
| `SELF_UPDATE_BRANCH` | `main` | 在线更新使用的固定 Git 分支 |
| `UPDATE_BACKUP_DIR` | 数据库同级 `backups` | 在线更新和手动下载数据库时使用的临时/持久备份目录 |

`SYNC_SCHEDULER_ENABLED=false` 和 `KEY_CHECK_SCHEDULER_ENABLED=false` 是启动级紧急硬锁，设置页不能绕过。其余调度间隔、并发、超时、告警阈值和保留数量作为首次运行/未保存控制台设置时的环境默认值；一旦在设置页保存，数据库中的运行设置优先并在下一次调度扫描时生效。保存设置本身不会立即触发同步或真实 Key 探测。

Key 自动探测会向真实模型端点发送最小请求，允许产生极低但非零的消费。检测模型候选不会自动更新，只在上游编辑页手动点击“同步模型”时刷新并保存到本地；下次手动同步前继续使用当前缓存。

## 更新说明

### v1.8.0 - 2026-07-21

- 设置页新增系统版本展示、远端更新检查和一键安装更新。
- 在线更新会先备份 SQLite，随后快进代码、安装锁定依赖并运行完整测试；失败时自动恢复原提交。
- 更新成功后退出当前进程，由 systemd 或 PM2 自动拉起新版并让前端自动刷新。
- 数据库下载改用 SQLite 在线备份 API，避免 WAL 模式下遗漏尚未 checkpoint 的数据。

### v1.7.1 - 2026-06-13

- 移除「Codex 倍率识别词」配置，改为按 Sub2API 分组平台（`openai` / `anthropic`）自动识别倍率。
- 上游列表新增 **OpenAI 倍率**、**Anthropic 倍率** 两列，展示各平台最低分组倍率。
- 详情页与模型价格摘要同步改为按平台展示，不再单独统计 Codex。
- 无 new-api `/api/pricing` 快照时，使用内置官方基准价叠加上游分组倍率，修复 `auto` 类型上游模型广场价格为空的问题。
- 新增「自己站观测」第一版：读取自己站账号管理 `/admin/accounts`，并支持绑定本地上游 Key 做采购倍率与售卖分组倍率对账。

### v1.7.0 - 2026-06-13

- 新增「API Key 管理」首页板块，跨上游查看、创建、启停和删除 Sub2API Key，并展示每个 Key 绑定的分组、平台与分组倍率。
- 新增 `src/upstreamKeys.js` 与 `/api/upstream-keys`、`/api/upstreams/:id/keys`、`/api/upstreams/:id/key-groups` 等接口。
- 创建 Key 时通过分组下拉选择 OpenAI / Claude 等线路，无需逐个登录上游网站。
- 新增 `upstream_api_key_snapshots` 和 `upstream_key_create_logs` 表，同步时保存 Key 快照与分组倍率，创建时加密保存完整密钥。
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
- 新增 `model_pricing_snapshots` 本地快照表，并在当前快照中保存 `pricing_summary`，用于展示模型数量、供应商数量、倍率范围和平台相关模型最低倍率。
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
