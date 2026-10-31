# 用户请求报错监控与 Hermes 闭环：部署说明

> 对应需求：[2026-10-30-公共分组用户错误监控与Hermes闭环方案.md](2026-10-30-公共分组用户错误监控与Hermes闭环方案.md)  
> 版本：v1.10.0

## 一、数据流

```text
自有 Sub2API ──(x-api-key 管理员接口)──> 控制台(服务器 :6060)
                                         │ 落库 / 去重 / 分流
             ┌───────────────────────────┼─────────────────────────┐
             ▼                           ▼                         ▼
        PushPlus + 邮箱          服务器 127.0.0.1:18644      仅记录（未命中）
                                         │ 反向 SSH 通道
                                         ▼
                              本机 Hermes 127.0.0.1:8644/webhooks/sub2api-errors
                                         │ 处理完成
                                         ▼
                              本机微信 Gateway 汇报 → 回执 → 控制台记录投递结果
```

1. 调度器每 10 秒检查一次，按「轮询周期」调用 `GET /api/v1/admin/ops/request-errors`（选了分组就按分组逐个查，未选则查全部分组，公共与专属都包含）。
2. 新错误按 `站点 ID + 错误 ID` 去重落库，状态为「读取详情中」。
3. 再按「每轮详情数量」读取 `/request-errors/:id` 与 `/request-errors/:id/upstream-errors?include_detail=1`。任一接口失败会按退避重试，超过「重试次数」后标记为**部分详情**，不会当作完整错误处理。
4. 提取错误码后分流：`manual_codes` 优先，其次 `hermes_codes`，都没命中的错误只记录。
5. 每个渠道（PushPlus、邮箱、Hermes、微信汇报）单独记录投递状态、尝试次数和最后错误。

## 二、控制台配置

入口：左侧导航「用户报错」。

### 1. 监控站点

站点来自「自己站观测」。每个站点填写**管理员 API Key**（加密存入 SQLite，页面只显示掩码），点「读取分组」拉取分组列表后勾选要监控的分组，再打开「监控」并保存。可以点「立即轮询」验证。

### 2. 错误码

两个列表都支持逗号或换行分隔，不区分大小写。可匹配：

| 来源 | 例子 |
| --- | --- |
| 本地分类 `phase / type / error_owner / error_source` | `upstream`、`upstream_error`、`provider` |
| 用户状态码、上游状态码 | `502`、`529`，或 `5xx`、`4xx` 这种整类写法 |
| 上游尝试记录的 `kind / reason / stage` | `retry_exhausted`、`http_error` |
| 上游错误正文 JSON 里的 `code / type / error_code / reason / status` | `insufficient_quota`、`overloaded_error` |

写法：

- 普通写法精确匹配错误码，例如 `insufficient_quota`、`529`。
- `5xx`、`4xx` 匹配一整类状态码。
- 带 `*` 的写法是通配，同时匹配错误码和错误消息文本，例如 `*insufficient*`；单独一个 `*` 表示全部。
- 加 `upstream:` 前缀只看上游返回的内容（上游状态码、上游尝试记录、上游错误正文和消息），不看本站自己报的错，例如 `upstream:*insufficient*`。

同一错误同时命中两组时按人工处理，保存时页面会提示重叠项。

HERMES_PROMPT 中的 `{codes}` 会替换成本次错误码；只靠 `*` 命中时显示实际错误码，而不是 `*`。

### 3. Hermes 通道

| 设置 | 说明 |
| --- | --- |
| Webhook 地址 | 默认 `http://127.0.0.1:18644/webhooks/sub2api-errors`。只接受回环 http 地址或 https 地址 |
| HMAC 密钥 | 至少 16 个字符，与 Hermes 路由的 `secret` 一致 |
| HERMES_PROMPT | 由你填写；发给 Hermes 的内容 = 提示词 + 本次错误详情（含上游报错） |
| 微信汇报目标 | 作为 payload 的 `report_target` 传给 Hermes 路由，可在路由的 `deliver_extra` 中引用 |
| 回执查询 | 打开后控制台会查询 Hermes 回执，确认微信汇报是否送达 |

也可以在服务器环境变量中注入，环境变量优先且页面不可修改：

```env
HERMES_WEBHOOK_URL=http://127.0.0.1:18644/webhooks/sub2api-errors
HERMES_WEBHOOK_SECRET=<与 Hermes 路由相同的长随机串>
# 设为 false 可强制停用监控
REQUEST_ERROR_MONITOR_ENABLED=true
```

### 4. 发送内容边界

- 发给 Hermes 的 payload 只有 `delivery_id`、`event_type`、`report_target`、`prompt` 和错误详情 `event`。
- 不包含管理员 API Key、HMAC 密钥、用户邮箱、客户端 IP 或 Key 前缀；正文中的 `Bearer …`、`sk-…`、`api_key=…`、`password=…`、代理 URL 账号密码等会再脱敏一次。
- 控制台不设置 Hermes 权限，也不限制它的处理动作。

## 三、本机 Hermes 路由

在 `~/.hermes/config.yaml` 的 `platforms.webhook.extra.routes` 下增加（端口沿用 Hermes 默认 8644）：

```yaml
platforms:
  webhook:
    extra:
      routes:
        sub2api-errors:
          events: ["sub2api.request_error"]
          secret: "<与控制台相同的 HMAC 密钥>"
          prompt: "{prompt}"
          deliver: "weixin"
          deliver_extra:
            chat_id: "{report_target}"   # 或直接写死你的微信目标
          receipts: true
```

`prompt: "{prompt}"` 让 Hermes 原样使用控制台拼好的「HERMES_PROMPT + 错误详情」。

`receipts: true` 依赖本机 Hermes 的回执补丁（`gateway/webhook_receipts.py` 和 `gateway/platforms/webhook.py` 中的 `/receipt` 路径）。补丁会：

- 把控制台签名 payload 中的 `delivery_id` 作为幂等键，重复投递返回 `duplicate`；
- 记录处理状态 `accepted / completed / failed / cancelled`；
- 记录最终文本发往微信的结果 `delivered / failed`；
- 提供 `POST /webhooks/sub2api-errors/receipt` 供控制台用同一 HMAC 查询。

该补丁目前只在本机工作区里，Hermes 自身测试套件尚未跑通，网关也还没有重启加载。上线前需要在 Hermes 仓库验证并重启网关。

没有补丁时可以在控制台关闭「查询 Hermes 回执」，此时微信汇报渠道显示「未启用」，控制台只记录「已提交 Hermes」，不会把它当成已解决。

## 四、反向 SSH 通道（本机 → 服务器）

本机主动连服务器，把服务器回环端口 18644 转发到本机 Hermes 8644。Hermes 端口不暴露到公网。

```bash
ssh -N -T \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:18644:127.0.0.1:8644 ubuntu@<服务器>
```

建议用密钥登录，并用 launchd 或 `autossh` 保持常驻。服务器 `sshd_config` 保持 `GatewayPorts no`，确保 18644 只监听服务器回环地址。

验证：控制台「用户报错 → 检测 Hermes 通道」会请求 `http://127.0.0.1:18644/health`。

## 五、断线与重试语义

| 情况 | 行为 |
| --- | --- |
| 通道断开 / Hermes 5xx / 超时 | Hermes 渠道保持「待投递」，按退避重试（单次间隔最长 30 分钟），直到超过「回执超时」窗口才标为失败 |
| Hermes 返回 4xx（如签名错误） | 计入「重试次数」，超过后标为失败 |
| PushPlus / 邮箱失败 | 按「重试次数」和翻倍退避重试 |
| Hermes 已受理 | 微信汇报保持「待投递」，显示 Hermes 处理状态 |
| 回执 `delivery=delivered` | 微信汇报标为已投递，保存 Hermes 汇报内容 |
| 回执 `delivery=failed` | 微信汇报标为失败 |
| Hermes 处理结束超过 2 分钟仍无微信投递记录 | 标为失败，提示未记录微信汇报 |
| 超过回执超时 | 标为失败（回执超时） |

失败的渠道可以在列表里点「重试」，已投递的渠道不会重复发送。PushPlus 和邮箱不依赖 Hermes 通道是否在线。
