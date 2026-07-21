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

Key 联通检测会使用每个上游配置的 OpenAI / Anthropic 检测模型发起最小真实请求，会产生极低但非零的消耗。上线前建议先为一个上游配置低成本模型，手动执行“立即检测”，确认后再开启定时检测。

PushPlus Token 可直接在“设置 → PushPlus”中加密保存、清空和测试。数据库配置优先于 `PUSHPLUS_TOKEN` 环境变量；两者都未配置时，告警仍会记录在控制台，但不会发送微信通知。

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
