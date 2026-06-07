# Sub2API Upstream Console

这是一个独立项目，用来集中管理多个上游 Sub2API 中转站账号。

目标不是修改任何一个中转站本体，而是做一个外部聚合控制台：

1. 录入多个上游站点的地址、账号/API Key、备注和同步策略。
2. 自动登录或调用上游接口，拉取余额、用量、分组倍率、可用渠道/模型等信息。
3. 在一个网页里集中展示所有上游状态，方便站长做成本、余额和倍率管理。
4. 保存历史快照，发现倍率变化、余额不足、同步失败、用量异常等风险。

需求文档见 [docs/PRD_CN.md](docs/PRD_CN.md)。

## 本地运行

```powershell
npm install
npm start
```

默认访问地址：

```text
http://localhost:4317
```

## 常用环境变量

- `PORT`：服务端口，默认 `4317`。
- `DATABASE_PATH`：SQLite 数据库路径，默认 `./data/upstream-console.sqlite`。
- `APP_SECRET`：上游凭证加密密钥，正式使用必须换成强随机字符串。
- `ADMIN_PASSWORD`：控制台登录密码；不设置时为本地开发免登录模式。
- `SESSION_SECRET`：登录 Cookie 签名密钥，默认复用 `APP_SECRET`。
- `SYNC_SCHEDULER_ENABLED`：是否启用后台定时同步，默认启用；设置为 `false` 可关闭。
- `SYNC_SCHEDULER_TICK_SECONDS`：后台同步扫描间隔，默认 `30` 秒。

## 当前功能

- 独立网页聚合多个上游。
- 上游账号密码或 Token 加密保存。
- 手动同步单个上游和全部上游。
- 后台按上游同步频率自动同步。
- 余额、用量、成本、API Key 数量和分组倍率展示。
- Codex 倍率别名配置。
- 低余额阈值和倍率变化提醒。
- 上游新增、编辑、删除和连接测试。
- 搜索、状态筛选、排序和倍率筛选。
- 可选控制台登录密码。
