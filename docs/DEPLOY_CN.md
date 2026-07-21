# 部署说明

## 本机运行

```powershell
npm install
copy .env.example .env
npm start
```

访问：

```text
http://localhost:4317
```

## 服务器运行

建议在 `.env` 中至少设置：

```env
PORT=4317
APP_SECRET=请替换成强随机字符串
SESSION_SECRET=请替换成另一个强随机字符串
ADMIN_PASSWORD=请设置控制台登录密码
SYNC_SCHEDULER_ENABLED=true
SYNC_SCHEDULER_TICK_SECONDS=30
KEY_CHECK_SCHEDULER_ENABLED=true
KEY_CHECK_SCHEDULER_TICK_SECONDS=30
KEY_CHECK_CONCURRENCY=3
KEY_CHECK_TIMEOUT_MS=15000
PUSHPLUS_TOKEN=请填写你的 PushPlus Token
ALERT_FAILURE_THRESHOLD=3
ALERT_RECOVERY_THRESHOLD=2
MAX_SYNC_LOGS=500
MAX_RATE_SNAPSHOTS=2000
```

生产环境必须设置 `ADMIN_PASSWORD`，否则任何能访问端口的人都能打开控制台。

`APP_SECRET` 同时用于加密上游凭证和完整 Key。导入 Key 时，后端会按 Sub2API 前端的请求方式添加 `X-User-UI-Request: 1`，完整 Key 仅以密文存储，不会下发到浏览器或写入错误日志。升级、备份和迁移时必须保留原 `APP_SECRET`，否则旧密文无法解密，需重新录入上游凭证并重新导入 Key。

检测模型候选仅在点击“同步模型”时更新并持久化保存；某个分组同步失败时会保留该分组上次的候选。每个 Key 都可以在“上游监控”或“Key 管理”中选择独立模型，生效优先级为 `Key 选择 > 分组选择 > 平台默认模型`。

Key 联通检测会使用上述生效模型发起最小真实请求，会产生极低但非零的消耗。OpenAI GPT / Codex 模型优先使用 `/v1/responses`，其他 OpenAI 模型优先使用 `/v1/chat/completions`，Anthropic 使用 `/v1/messages`。上线前建议先手动执行一次“立即检测”；如显示“出口 IP 被拒绝”，说明请求已到达上游但当前服务器出口 IP 不在上游允许范围，需先在上游处放行。确认结果后再开启定时检测。

PushPlus Token 可直接在“设置 → PushPlus”中加密保存、清空和测试。数据库配置优先于 `PUSHPLUS_TOKEN` 环境变量；两者都未配置时，告警仍会记录在控制台，但不会发送微信通知。

## 运行设置优先级

“设置”页分为“通知规则”“自动任务”“上游策略”“系统保留”。通知开关、合并方式、失败/恢复阈值、重复提醒、免打扰、调度间隔、探测并发/超时和保留数量保存后热生效，无需重启。保存动作只更新配置，不会立即执行同步或真实 Key 探测；调度器会在后续扫描中按新的周期判断到期任务。

`SYNC_SCHEDULER_ENABLED=false` 和 `KEY_CHECK_SCHEDULER_ENABLED=false` 是启动级紧急硬锁，控制台不能重新打开。其他环境变量是未保存运行设置时的默认值；在设置页保存后，数据库运行设置优先。每个上游还可以单独关闭自动同步、Key 探测、微信通知或余额预警，并设置自己的周期和阈值；执行优先级为“环境硬锁 → 全局运行设置 → 上游策略”。

检测模型目录不会自动同步。只有在上游编辑页点击“同步模型”才会从上游模型接口和近期使用记录刷新候选并保存到本地；下次手动同步前继续使用当前缓存。Key 自动探测会发起最小真实模型请求，可能产生极低但非零的消费，缩短周期或提高并发前应先手动检测少量 Key。

告警状态中的“已处理”不等于“已恢复”。单条或批量标记已处理后，事故仍保持打开，但停止重复提醒；只有后续真实同步成功或 Key 连续恢复达到阈值时，才会转为“已恢复”，并按通知规则决定是否发送恢复消息。

## 反向代理

可以用 Nginx、Caddy 或宝塔反向代理到本地端口：

```text
http://127.0.0.1:4317
```

建议同时启用 HTTPS，并限制访问来源。

## 升级流程

```powershell
git pull
npm install
npm test
npm start
```

如果使用进程管理器，例如 PM2、systemd、宝塔 Node 项目，需要重启对应服务。

新增表和字段会在进程启动时由 SQLite 初始化逻辑自动创建，无需单独执行迁移命令。升级前仍建议备份数据库和 `.env`。
