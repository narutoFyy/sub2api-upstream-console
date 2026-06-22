# API Key 绑定分组展示需求文档

## 背景

当前控制台已经能接入多个上游，并展示上游余额、用量、分组倍率、模型价格和 API Key 管理能力。接下来需要增强 API Key 展示：用户查看每个上游的密钥时，不仅能看到密钥本身，还要清楚看到该密钥绑定的分组。

这个能力用于判断某个 Key 实际走的是 OpenAI、Anthropic、Codex 或其他平台线路，以及对应的上游倍率，避免用户只看到一串 Key 却不知道它会按哪个分组计费。

## 目标

1. 在跨上游 API Key 列表中展示每个 Key 的绑定分组。
2. 在单个上游详情页或单上游 Key 列表中展示每个 Key 的绑定分组。
3. 展示信息至少包含分组名称；如果上游接口提供更多信息，应同时展示平台、倍率和分组 ID。
4. 创建或修改 Key 后，列表里的绑定分组信息要能及时更新。

## 范围

### 必须支持

- Sub2API 上游：
  - 读取 `GET /api/v1/keys` 返回的 Key 列表。
  - 解析 Key 绑定的 `group_id`、`group_name` 或等价字段。
  - 结合 `GET /api/v1/groups/available` 和 `GET /api/v1/groups/rates` 补充分组名称、平台与倍率。

- 控制台展示：
  - 跨上游 API Key 管理列表显示“绑定分组”列。
  - 上游详情中的 Key 列表显示“绑定分组”字段。
  - 创建 Key 弹窗中选择分组后，创建成功结果展示完整 Key 和绑定分组。

### 可选支持

- NewAPI 上游：
  - 如果 `/api/token/` 或相关接口返回分组字段，则展示。
  - 如果 NewAPI 不返回绑定分组，则显示“未返回分组”，不要猜测。

## 数据字段

本地 Key 快照建议至少保存：

| 字段 | 说明 |
| --- | --- |
| `upstream_site_id` | 上游站点 ID |
| `key_id` | 上游返回的 Key ID |
| `key_name` | Key 名称 |
| `key_masked` | 掩码后的 Key |
| `group_id` | 绑定分组 ID |
| `group_name` | 绑定分组名称 |
| `group_platform` | 分组平台，例如 `openai`、`anthropic` |
| `group_rate` | 当前用户在该分组下的倍率 |
| `status` | Key 状态 |
| `quota` | 配额 |
| `used_quota` | 已用配额 |
| `expires_at` | 过期时间 |
| `last_used_at` | 最后使用时间 |
| `captured_at` | 同步时间 |

## 展示规则

1. 如果 Key 返回了明确的 `group_name`，优先展示该名称。
2. 如果 Key 只有 `group_id`，用可用分组列表补齐 `group_name`。
3. 如果能匹配到分组倍率，显示为 `分组名 · 平台 · 0.3x`。
4. 如果只能拿到 `group_id`，显示为 `分组 #id`。
5. 如果上游没有返回任何分组信息，显示 `未返回分组`。
6. 不展示完整 Key 明文，除非是刚创建成功后的单次结果弹窗。

## 接口需求

### 聚合 Key 列表

`GET /api/upstream-keys`

返回的每个 Key 项应包含：

```json
{
  "upstream_site_id": 1,
  "upstream_name": "example upstream",
  "key_id": "123",
  "key_name": "codex key",
  "key_masked": "sk-***abcd",
  "group_id": "10",
  "group_name": "gpt(混合号池)",
  "group_platform": "openai",
  "group_rate": 0.3,
  "status": "active"
}
```

### 单上游 Key 列表

`GET /api/upstreams/:id/keys`

返回字段与聚合列表保持一致，但只包含指定上游。

### 单上游可用分组

`GET /api/upstreams/:id/key-groups`

用于创建 Key 和补齐已有 Key 的分组信息。每个分组至少包含：

```json
{
  "group_id": "10",
  "group_name": "gpt(混合号池)",
  "platform": "openai",
  "rate": 0.3
}
```

## 页面需求

### 跨上游 API Key 管理区

列表列建议：

- 上游
- Key 名称
- 掩码 Key
- 绑定分组
- 平台
- 分组倍率
- 状态
- 配额 / 已用
- 过期时间
- 最后使用时间

筛选建议：

- 按上游筛选
- 按平台筛选
- 按绑定分组筛选
- 按状态筛选
- 按 Key 名称搜索

### 上游详情页

在上游详情页的 Key 区块中，Key 项必须展示绑定分组。用户不需要进入上游官网，也能判断每个 Key 对应的分组线路。

## 同步策略

1. 同步上游时，拉取 Key 列表。
2. 同步或创建 Key 前，拉取可用分组和用户分组倍率。
3. 将 Key 的 `group_id` 与分组列表做匹配，补齐 `group_name`、`platform` 和 `rate`。
4. 保存快照时只保存掩码 Key 和分组元数据，不保存历史完整 Key 明文。
5. 创建或修改 Key 后，主动刷新该上游 Key 列表，避免页面显示旧分组。

## 验收标准

- 至少一个 Sub2API 上游能在控制台看到 Key 列表。
- 每个有分组信息的 Key 都能展示绑定分组名称。
- 能展示分组平台和倍率时，不丢失这些信息。
- 创建 Key 后，成功弹窗显示完整 Key 和绑定分组。
- 修改 Key 分组后，列表刷新并显示新分组。
- 上游未返回分组时，页面显示 `未返回分组`，不显示空白或错误字段。
- 前端和日志不泄露历史完整 Key 明文。
