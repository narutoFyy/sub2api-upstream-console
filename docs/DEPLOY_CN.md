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
MAX_SYNC_LOGS=500
MAX_RATE_SNAPSHOTS=2000
```

生产环境必须设置 `ADMIN_PASSWORD`，否则任何能访问端口的人都能打开控制台。

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
