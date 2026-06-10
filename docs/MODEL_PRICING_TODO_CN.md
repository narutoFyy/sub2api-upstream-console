# 模型广场官方原价与上游实际价格 TODO

## 目标

做一个独立的“模型广场价格对比”功能，不只是显示上游返回的模型倍率，而是要回答这些问题：

1. 某个模型的官方原价是多少，例如 `gpt-5.5` 输入每 100 万 token 多少美元、输出每 100 万 token 多少美元。
2. 某个上游对这个模型配置了多少倍率，例如 `1x`、`0.5x`、`2x`。
3. 叠加上游倍率后，用户实际使用这个上游调用该模型时，每 100 万 token 大约多少钱。
4. 多个上游接入后，可以横向比较同一个模型在哪个上游更便宜。
5. 页面先不做复杂搜索，优先固定分成 `OpenAI` 和 `Claude` 两个板块，每个板块列出该厂商下所有模型。

## 概念澄清

- 官方原价：来自 QuantumNous/new-api 模型广场的标准价格基准，用来表示模型本身的原始价格。
- 模型倍率：new-api pricing 里的 `model_ratio`，用于换算 token 模型的基础价格。
- 输出倍率：new-api pricing 里的 `completion_ratio`，用于计算输出 token 价格。
- 上游分组倍率：上游账号所在分组或模型可用分组的倍率，例如 `default`、`vip`、`GPT-Plus` 等。
- 实际价格：官方原价或模型广场基准价叠加上游倍率后的最终估算价格。
- 固定价格模型：`quota_type = 1` 时，不按 token 计费，而是使用 `model_price` 作为每次请求/任务价格。

## NewAPI 源码中的价格公式

参考 `QuantumNous/new-api` 的 `web/default/src/features/pricing/lib/price.ts`：

- token 模型输入价：
  `input_price_per_1M = model_ratio * 2 * group_ratio`

- token 模型输出价：
  `output_price_per_1M = model_ratio * 2 * completion_ratio * group_ratio`

- 缓存读取价：
  `cache_price_per_1M = model_ratio * 2 * cache_ratio * group_ratio`

- 缓存写入价：
  `create_cache_price_per_1M = model_ratio * 2 * create_cache_ratio * group_ratio`

- 固定价格模型：
  `request_price = model_price * group_ratio`

说明：模型广场前端按 token unit `M` 展示时，上面这些值就是每 100 万 token 的美元价格。后续如果要显示人民币，可以再叠加汇率。

## 数据来源

### 官方模型广场基准

- 优先从 QuantumNous/new-api 官方项目或标准模型广场数据获取。
- 当前可直接从上游 NewAPI 的 `GET /api/pricing` 读取模型广场结构。
- 如果要尽量接近“官方原价”，需要支持一个全局基准源，而不是只相信某个上游自己的 `/api/pricing`。

建议支持三种来源：

- 内置基准表：项目内置一份常用模型官方价格表，例如 OpenAI、Claude、Gemini、DeepSeek 等。
- NewAPI pricing 源：从某个可信 NewAPI 站点的 `/api/pricing` 拉取模型广场价格。
- 手动覆盖：允许用户手动修改某个模型的官方输入价、输出价、缓存价。

### 上游实际倍率

- 对 new-api 上游，读取 `/api/pricing` 中的 `enable_groups`、`group_ratio`、`model_ratio`、`completion_ratio`、`model_price`。
- 对 sub2api 上游，继续读取现有分组倍率接口，映射到同一套实际价格计算模型。
- 如果上游没有开放 `/api/pricing`，降级读取 `/api/ratio_config`。
- 如果仍然拿不到，则只显示“该上游暂不支持模型价格计算”。

## 数据结构 TODO

- [ ] 新增“官方模型基准价格”表，例如 `official_model_prices`。
- [ ] 字段建议：`model_name`、`vendor`、`input_usd_per_1m`、`output_usd_per_1m`、`cache_read_usd_per_1m`、`cache_write_usd_per_1m`、`request_usd`、`source`、`source_version`、`updated_at`。
- [ ] 新增“上游模型实际价格快照”表，例如 `upstream_model_effective_prices`。
- [ ] 字段建议：`upstream_site_id`、`model_name`、`group_name`、`group_ratio`、`model_ratio`、`completion_ratio`、`input_usd_per_1m`、`output_usd_per_1m`、`cache_read_usd_per_1m`、`cache_write_usd_per_1m`、`request_usd`、`captured_at`。
- [ ] 保留原始 pricing payload，方便排查不同 NewAPI 版本字段差异。

## 后端 TODO

- [ ] 抽象价格计算模块，例如 `src/modelPricing.js`。
- [ ] 实现 `calculateNewAPITokenPrice(model, groupRatio)`，严格按 NewAPI 源码公式计算。
- [ ] 实现固定价格模型计算：`model_price * group_ratio`。
- [ ] 支持按模型名归一化，例如 `gpt-5.5`、`openai/gpt-5.5`、`gpt-5.5-2026-xx` 可以映射到同一个官方模型。
- [ ] 支持官方价格基准导入/更新接口。
- [ ] 同步上游时同时计算“上游实际价格快照”。
- [ ] 对同模型多上游价格做聚合接口，例如 `GET /api/model-price-comparison?model=gpt-5.5`。
- [ ] 返回字段必须同时包含官方原价和上游实际价格，避免只显示倍率。

## 前端 TODO

- [ ] 新增“模型广场价格”独立页面入口。
- [ ] 页面主体固定分成两个板块：`OpenAI 模型` 和 `Claude 模型`。
- [ ] `OpenAI 模型` 板块列出 OpenAI/GPT 系列模型，例如 `gpt-5.5`、`gpt-5.4`、`gpt-5-mini`、`gpt-4.1`、`gpt-4o`、`o3`、`o4-mini` 等。
- [ ] `Claude 模型` 板块列出 Claude 系列模型，例如 `claude-sonnet`、`claude-opus`、`claude-haiku` 等。
- [ ] 每个模型卡片显示官方原价：
  `输入 $x / 100万 token`、`输出 $y / 100万 token`、`缓存读写价格`。
- [ ] 每个模型卡片下面直接展示所有上游对该模型的实际价格，不要求用户先搜索。
- [ ] 每个上游显示：上游名称、可用分组、分组倍率、输入实际价、输出实际价、缓存实际价、更新时间。
- [ ] 支持按价格从低到高排序。
- [ ] 每个板块内支持折叠/展开，默认优先展开常用模型。
- [ ] 后续再扩展 Gemini、DeepSeek、Grok 等更多厂商板块；第一版只做 OpenAI 和 Claude。
- [ ] 支持标记最低价上游。
- [ ] 支持显示“官方原价 vs 上游实际价”的倍数差异。
- [ ] 对没有 pricing 接口的上游显示“暂不支持价格计算”，不要混入可比较列表。

## 展示示例

板块：`OpenAI 模型`

模型：`gpt-5.5`

官方原价：

- 输入：`$5 / 100万 token`
- 输出：`$15 / 100万 token`

上游 A：

- 分组倍率：`0.8x`
- 输入实际价：`$4 / 100万 token`
- 输出实际价：`$12 / 100万 token`

上游 B：

- 分组倍率：`1.2x`
- 输入实际价：`$6 / 100万 token`
- 输出实际价：`$18 / 100万 token`

板块：`Claude 模型`

模型：`claude-sonnet`

官方原价：

- 输入：`$3 / 100万 token`
- 输出：`$15 / 100万 token`

上游 A：

- 分组倍率：`1x`
- 输入实际价：`$3 / 100万 token`
- 输出实际价：`$15 / 100万 token`

## 风险和注意点

- 不同 NewAPI 站点的 `/api/pricing` 可能是站长自己改过的，不一定等于官方原价。
- 所以“官方原价”最好有独立可信来源，不能完全依赖任意上游。
- `model_ratio` 不是直接显示给用户看的美元价格，需要按 NewAPI 公式换算。
- `completion_ratio` 会让输入价和输出价不同，不能只显示一个价格。
- `quota_type = 1` 的模型不是 token 价格，不能显示成每 100 万 token。
- 上游分组倍率和模型倍率必须分开展示：前者是上游/分组折扣，后者是模型本身价格基准。
- 如果上游没有返回用户可用分组，要默认使用最低可用分组倍率或提示“不确定实际分组”。

## 实施顺序

1. 先做价格计算模块，把 NewAPI 源码公式复制成后端可测试函数。
2. 再做官方价格基准表，先内置少量常用模型用于验证。
3. 再把当前已同步的 `/api/pricing` 数据转换成实际价格快照。
4. 再做独立前端页面，先固定展示 OpenAI 和 Claude 两个板块，并在每个模型下展示上游价格对比。
5. 最后做价格变化记录、最低价提醒和批量排序。
