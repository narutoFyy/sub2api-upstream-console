# Sub2API 上游聚合管理控制台需求文档

版本：v0.2  
日期：2026-06-07  
项目类型：独立 Web 项目  
项目名称建议：Sub2API Upstream Console

## 1. 一句话定位

做一个独立网页，把你在多个上游 Sub2API 中转站里的账号、余额、Token 用量、分组倍率、模型/渠道状态集中拉取并展示，方便你不用挨个登录上游后台就能管理成本和供应商状态。

## 2. 核心边界

这个项目不改现有 `sub2api` 中转站源码，也不作为其中一个功能模块嵌入。它是一个单独部署的管理控制台，有自己的前端、后端、数据库和同步任务。

它像一个“外部观察台”：

1. 你在控制台里录入上游地址和登录凭证。
2. 控制台后端代表你去访问各个上游 Sub2API。
3. 控制台把拉回来的余额、用量、倍率、模型和状态保存成快照。
4. 前端只展示本控制台后端整理后的数据，不直接暴露上游密码和 Token。

## 3. 为什么需要后端

不能只做纯前端网页，原因是：

1. 浏览器直接请求多个上游会遇到 CORS 限制。
2. 上游账号密码、JWT、API Key 放在浏览器里不安全。
3. 实时同步、定时拉取、失败重试、历史快照都需要后台任务。
4. 分组倍率变化、余额趋势、用量对账需要数据库保存历史数据。

因此推荐架构是：独立前端 + 独立后端 API + 数据库 + 定时同步 Worker。

## 4. 使用场景

1. 你接入了 10 个上游，每天想快速看哪个余额快没了。
2. 某个上游 Codex 分组倍率临时上调，你想第一时间看到。
3. 你想比较不同上游今日 Token 消耗、请求量、成本和可用状态。
4. 你想知道某个上游是不是登录失效、接口异常、返回 401/403/429。
5. 你想给每个上游加备注，例如“便宜但慢”“Codex 倍率低”“备用线路”。
6. 你想保留倍率和余额历史，方便后面复盘哪个上游更稳、更划算。

## 5. MVP 目标

第一版先做到“能录入、能同步、能集中看、能发现变化”。

MVP 必须支持：

1. 新增、编辑、删除上游站点。
2. 保存上游 Base URL、账号密码或访问 Token、备注、标签。
3. 测试上游登录和接口可用性。
4. 拉取并展示当前余额。
5. 拉取并展示今日/近 7 天/近 30 天用量。
6. 拉取并展示当前分组倍率，重点关注 Codex 相关分组。
7. 分组倍率变化时保存快照并在页面提示。
8. 展示所有上游的同步状态、最近同步时间、失败原因。
9. 支持手动刷新和定时刷新。
10. 敏感信息加密保存，不在前端明文回显。

## 6. 非目标

MVP 暂不做：

1. 不直接转发用户 API 请求。
2. 不替代 Sub2API 自身的账号、渠道、用户、支付管理。
3. 不自动充值上游。
4. 不自动修改上游倍率或分组。
5. 不破解验证码、二次验证、Cloudflare 防护。
6. 不保证所有魔改版 Sub2API 都能零配置适配。

## 7. 上游接入方式

### 7.1 账号密码登录模式

适合你在上游有普通用户账号，可以登录上游后台。

录入字段：

1. 上游名称
2. Base URL，例如 `https://api.xxx.com`
3. 登录账号，通常是邮箱或用户名
4. 登录密码
5. 可选 2FA 说明
6. 备注和标签

同步方式：

1. 后端调用上游登录接口获取访问 Token。
2. 后端缓存 Token，到期后自动重新登录。
3. 后端用 Token 拉取用户资料、余额、用量和分组倍率。

风险：

1. 如果上游启用了验证码、Cloudflare 或强制 2FA，自动登录可能失败。
2. 如果上游接口版本差异较大，需要单独适配。

### 7.2 手动 Token 模式

适合上游登录比较复杂，但你能手动复制访问 Token。

录入字段：

1. Base URL
2. Bearer Token 或 Cookie
3. Token 过期时间，可选

同步方式：

1. 后端直接用 Token 请求上游接口。
2. Token 失效后页面提示重新填写。

### 7.3 API Key 模式

适合只拿到了上游给你的 API Key。

能力限制：

1. API Key 通常可以调用模型接口。
2. API Key 不一定能查余额、分组倍率、账户用量。
3. 如果上游没有提供 API Key 查询接口，只能做健康检查和模型测试。

页面需要明确标注“该上游当前凭证不支持余额/倍率同步”。

### 7.4 管理员模式

适合你同时也是某个上游 Sub2API 的管理员。

能力：

1. 可读取更完整的账号、分组、倍率、渠道和用量数据。
2. 可扩展做供应商级别对账。

MVP 可以先保留接口设计，优先实现普通用户登录模式。

## 8. 推荐采集接口

以下接口按当前开源 Sub2API 常见结构设计，实际项目需要做版本兼容和失败降级。

### 8.1 登录

`POST /api/v1/auth/login`

用途：用账号密码换取访问 Token。

### 8.2 用户资料和余额

`GET /api/v1/user/profile`

用途：读取用户名、邮箱、余额、并发等用户基础信息。

### 8.3 用量概览

`GET /api/v1/usage/dashboard/stats`

用途：读取当前用户总请求、今日请求、Token、成本等概览。

### 8.4 用量统计

`GET /api/v1/usage/stats?period=today`

可选 period：

1. `today`
2. `week`
3. `month`
4. `year`

用途：按周期拉取用量统计。

### 8.5 分组倍率

`GET /api/v1/groups/rates`

用途：读取当前用户可用分组的倍率配置。这个接口是本项目重点，需要定时拉取并保存历史快照，用来发现 Codex 或其他分组倍率是否变化。

### 8.6 可用分组

`GET /api/v1/groups/available`

用途：读取当前用户可绑定的分组、分组名称和基础信息。

### 8.7 API Keys

`GET /api/v1/keys`

用途：读取当前上游账号下的 API Key 列表、绑定分组、状态、额度等。

### 8.8 可用渠道/模型

`GET /api/v1/channels/available`

用途：读取用户可见的渠道或模型能力。不同版本返回结构可能不同，需要适配器容错。

## 9. 页面需求

### 9.1 登录页

这是你自己的控制台登录页，不是上游登录页。

字段：

1. 控制台用户名
2. 控制台密码

要求：

1. 首次启动需要创建管理员账号。
2. 支持修改控制台密码。
3. 后续可增加 2FA。

### 9.2 总览仪表盘

路径建议：`/dashboard`

顶部卡片：

1. 上游总数
2. 正常上游数
3. 同步失败数
4. 余额不足数
5. 今日总 Token
6. 今日总成本
7. 倍率变化提醒数

核心列表：

1. 上游名称
2. 当前余额
3. 今日 Token
4. 今日成本
5. Codex 当前倍率
6. 最近倍率变化
7. 同步状态
8. 最近同步时间

### 9.3 上游列表页

路径建议：`/upstreams`

字段：

1. 名称
2. Base URL
3. 登录方式
4. 状态：正常、登录失效、同步失败、余额不足、停用
5. 余额
6. 今日请求量
7. 今日 Token
8. 今日成本
9. Codex 倍率
10. 最低倍率分组
11. 最高倍率分组
12. 最近同步时间
13. 备注

操作：

1. 新增上游
2. 编辑上游
3. 手动同步
4. 测试登录
5. 查看详情
6. 停用
7. 删除

筛选：

1. 按名称/网址搜索
2. 按标签筛选
3. 按状态筛选
4. 只看余额不足
5. 只看倍率变化
6. 只看同步失败

### 9.4 上游详情页

路径建议：`/upstreams/:id`

Tab：

1. 概览
2. 余额
3. 用量
4. 分组倍率
5. API Keys
6. 可用渠道/模型
7. 同步日志
8. 设置

概览展示：

1. 当前余额
2. 今日 Token
3. 近 7 天 Token
4. 今日成本
5. 当前 Codex 倍率
6. 最近同步状态
7. 最近错误

分组倍率 Tab：

1. 分组名称
2. 分组 ID
3. 平台或模型范围
4. 当前倍率
5. 上次倍率
6. 变化方向
7. 变化时间
8. 是否 Codex 相关

### 9.5 倍率变化中心

路径建议：`/rate-changes`

用途：集中查看所有上游的倍率变动。

字段：

1. 上游名称
2. 分组名称
3. 模型或平台
4. 旧倍率
5. 新倍率
6. 变化百分比
7. 发现时间
8. 状态：未读、已确认

### 9.6 同步日志页

路径建议：`/sync-logs`

字段：

1. 上游名称
2. 同步类型
3. 状态
4. 开始时间
5. 耗时
6. HTTP 状态码
7. 错误信息

同步类型：

1. 登录
2. 余额
3. 用量
4. 分组倍率
5. API Keys
6. 渠道/模型

## 10. 数据模型

### 10.1 upstream_sites

保存上游站点。

字段：

1. `id`
2. `name`
3. `base_url`
4. `auth_mode`：password、token、api_key、admin
5. `status`：active、disabled、login_failed、sync_failed
6. `tags`
7. `notes`
8. `sync_interval_seconds`
9. `last_sync_at`
10. `last_sync_error`
11. `created_at`
12. `updated_at`

### 10.2 upstream_credentials

保存敏感凭证。

字段：

1. `id`
2. `upstream_site_id`
3. `encrypted_username`
4. `encrypted_password`
5. `encrypted_token`
6. `encrypted_api_key`
7. `token_expires_at`
8. `created_at`
9. `updated_at`

要求：所有敏感字段必须加密存储。

### 10.3 upstream_current_snapshots

保存每个上游的当前状态。

字段：

1. `upstream_site_id`
2. `balance`
3. `balance_currency`
4. `today_requests`
5. `today_tokens`
6. `today_cost`
7. `week_tokens`
8. `month_tokens`
9. `codex_rate`
10. `min_rate`
11. `max_rate`
12. `last_payload`
13. `captured_at`

### 10.4 group_rate_snapshots

保存分组倍率历史。

字段：

1. `id`
2. `upstream_site_id`
3. `group_id`
4. `group_name`
5. `scope`
6. `model`
7. `rate`
8. `raw_payload`
9. `captured_at`

### 10.5 rate_change_events

保存倍率变化事件。

字段：

1. `id`
2. `upstream_site_id`
3. `group_id`
4. `group_name`
5. `old_rate`
6. `new_rate`
7. `change_percent`
8. `detected_at`
9. `acknowledged_at`

### 10.6 sync_logs

保存同步日志。

字段：

1. `id`
2. `upstream_site_id`
3. `sync_type`
4. `status`
5. `started_at`
6. `finished_at`
7. `duration_ms`
8. `http_status`
9. `error_message`
10. `summary`

## 11. 后端接口

### 11.1 控制台自己的接口

前端只调用自己的后端。

接口建议：

1. `POST /api/auth/login`
2. `GET /api/dashboard`
3. `GET /api/upstreams`
4. `POST /api/upstreams`
5. `GET /api/upstreams/:id`
6. `PUT /api/upstreams/:id`
7. `DELETE /api/upstreams/:id`
8. `POST /api/upstreams/:id/test-login`
9. `POST /api/upstreams/:id/sync`
10. `GET /api/upstreams/:id/rates`
11. `GET /api/upstreams/:id/usage`
12. `GET /api/upstreams/:id/sync-logs`
13. `GET /api/rate-changes`
14. `POST /api/rate-changes/:id/ack`

### 11.2 上游调用由后端适配器完成

前端不直接请求：

1. `https://上游/api/v1/auth/login`
2. `https://上游/api/v1/user/profile`
3. `https://上游/api/v1/groups/rates`

原因是避免 CORS、凭证泄漏和跨站安全问题。

## 12. 同步策略

### 12.1 定时同步

默认周期：

1. 余额：每 60 秒到 5 分钟。
2. 用量：每 5 分钟。
3. 分组倍率：每 60 秒到 3 分钟。
4. API Keys：每 10 分钟。
5. 渠道/模型：每 30 分钟。

你最关心倍率变化，所以 Codex 分组倍率可以单独设置更短周期。

### 12.2 手动刷新

每个上游支持手动刷新：

1. 刷新全部
2. 只刷新余额
3. 只刷新用量
4. 只刷新倍率
5. 只测试登录

### 12.3 实时定义

MVP 的“实时”建议定义为：

1. 页面每 30 秒自动刷新当前快照。
2. 后端倍率同步每 60 秒执行一次。
3. 用户可以点“立即同步”获取最新数据。

后续可增加 WebSocket 或 SSE，把倍率变化实时推到页面。

## 13. 告警需求

MVP 页面内提醒：

1. 余额低于阈值。
2. 上游登录失败。
3. 上游同步失败。
4. Codex 倍率上调。
5. Codex 倍率下降。
6. 今日用量异常增长。

二期通知渠道：

1. 邮件
2. Telegram
3. 企业微信
4. 飞书
5. 自定义 Webhook

## 14. 安全要求

1. 上游密码、Token、API Key 必须加密保存。
2. 加密主密钥从环境变量读取，不写入数据库。
3. 前端永远不回显完整密码、Token、API Key。
4. 日志中必须脱敏 `Authorization`、Cookie、API Key、密码。
5. 后端请求上游时必须限制协议为 HTTP/HTTPS。
6. 需要防 SSRF，禁止请求内网地址、localhost、metadata 地址。
7. 每次查看、修改、测试凭证都写审计日志。
8. 支持备份，但备份文件里的敏感字段也必须保持加密。

## 15. 技术方案建议

为了快速独立开发，推荐：

前端：

1. Vue 3
2. Vite
3. TypeScript
4. Tailwind CSS
5. ECharts 或 Chart.js

后端：

1. Node.js + TypeScript
2. Fastify 或 NestJS
3. Prisma ORM
4. SQLite 起步，后续可切 PostgreSQL
5. BullMQ 或内置定时任务做同步 Worker

部署：

1. Docker Compose
2. 单容器也可以，前后端一起打包
3. `.env` 配置数据库、加密密钥、管理员初始账号

## 16. MVP 验收标准

1. 可以新建一个独立项目并启动网页。
2. 可以登录自己的控制台。
3. 可以新增一个上游 Sub2API 站点。
4. 可以通过账号密码测试上游登录。
5. 可以拉取上游余额并展示。
6. 可以拉取上游今日 Token 和成本并展示。
7. 可以拉取 `/groups/rates` 并展示当前分组倍率。
8. Codex 相关倍率变化后能保存事件并在页面提示。
9. 可以查看每个上游最近同步成功或失败原因。
10. 刷新页面后历史上游配置和快照仍然存在。
11. 前端看不到上游密码、Token、API Key 明文。

## 17. 待确认问题

1. 你登录上游一般是邮箱密码，还是只拿到了 API Key？
2. 上游是否普遍开启 2FA、验证码或 Cloudflare？
3. 你说的 Codex 倍率，是所有上游都通过 `/groups/rates` 能拿到，还是有些只能在网页里看到？
4. 余额单位是否都是美元，还是有人民币、积分、Token 等不同单位？
5. 是否需要把上游 API Key 列表也显示出来，还是只显示站点级别余额和倍率？
6. 是否需要手机端适配，方便随时看余额和倍率？

## 18. 推荐开发顺序

1. 搭建独立项目骨架。
2. 实现控制台登录和本地管理员账号。
3. 实现上游站点 CRUD。
4. 实现 Sub2API 登录适配器。
5. 实现余额同步。
6. 实现分组倍率同步和变化检测。
7. 实现用量同步。
8. 实现总览仪表盘。
9. 实现详情页和同步日志。
10. 增加告警和通知。

