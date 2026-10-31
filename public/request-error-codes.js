// Error codes yf-mail (Sub2API) records in its ops error log, grouped for the
// hermes_codes / manual_codes pickers. upstream: values only match fields copied
// from the upstream response; local: values only match what this server produced.
// Sources: sub2-fwq2 backend/internal/handler/ops_error_logger.go (phase/owner/source,
// local codes), service/ops_upstream_context.go and the gateway services (kind/stage/reason).
(function (root) {
  const item = (prefix) => ([code, label]) => ({ value: `${prefix}:${code}`, code, label });
  const up = item('upstream');
  const local = item('local');

  const REQUEST_ERROR_CODE_GROUPS = [
    {
      id: 'upstream',
      title: '上游报错',
      short: '上游',
      hint: '上游账号 / 供应商返回的错误，前缀 upstream:',
      sections: [
        {
          title: '上游 HTTP 状态码',
          items: [
            ['4xx', '全部 4xx'], ['5xx', '全部 5xx'],
            ['400', '请求参数错误'], ['401', '账号鉴权失败'], ['402', '账号欠费'], ['403', '账号被拒 / 封禁'],
            ['404', '模型或路径不存在'], ['408', '请求超时'], ['413', '请求体过大'], ['429', '账号限流'],
            ['500', '上游内部错误'], ['502', '上游网关错误'], ['503', '上游不可用'], ['504', '上游网关超时'],
            ['520', 'Cloudflare 未知错误'], ['524', 'Cloudflare 超时'], ['529', '上游过载（Anthropic）']
          ].map(up)
        },
        {
          title: '上游错误类型（响应体 type / code）',
          items: [
            ['overloaded_error', '服务过载'], ['rate_limit_error', '限流'], ['rate_limit_exceeded', '限流（OpenAI）'],
            ['insufficient_quota', '额度不足（OpenAI）'], ['billing_error', '计费错误'],
            ['authentication_error', '鉴权失败'], ['invalid_api_key', '无效 Key（OpenAI）'], ['permission_error', '无权限'],
            ['invalid_request_error', '请求无效'], ['request_too_large', '请求过大'], ['context_length_exceeded', '上下文超长'],
            ['not_found_error', '资源不存在'], ['model_not_found', '模型不存在'],
            ['api_error', '上游 API 错误'], ['server_error', '上游服务器错误']
          ].map(up)
        },
        {
          title: '转发过程（尝试记录 kind）',
          items: [
            ['http_error', '上游返回错误状态'], ['failover', '切换账号重试'], ['failover_on_400', '400 后切换账号'],
            ['credential_failover', '凭据失败后切换'], ['retry', '同账号重试'], ['retry_exhausted', '重试耗尽'],
            ['retry_exhausted_failover', '重试耗尽后切换'], ['request_error', '连接上游失败'], ['response_error', '读取上游响应失败'],
            ['stream_error', '流式响应出错'], ['stream_failed', '流式响应失败'], ['ws_error', 'WebSocket 出错'],
            ['first_output_timeout', '首字超时'], ['prompt_too_long', '提示词过长'], ['signature_error', '思考签名错误'],
            ['budget_constraint_error', '思考预算错误']
          ].map(up)
        },
        {
          title: '失败阶段（stage）',
          items: [['account_auth', '账号凭据获取 / 刷新失败'], ['inference', '推理请求失败']].map(up)
        },
        {
          title: '失败原因（reason）',
          items: [
            ['openai_request_body_too_large', 'OpenAI 请求体过大'], ['openai_upstream_access_state', 'OpenAI 账号访问受限'],
            ['openai_http_continuation_unsupported', 'OpenAI 不支持续写'], ['openai_images_insufficient_balance', 'OpenAI 生图余额不足'],
            ['antigravity_oauth_credential_rejected', 'Antigravity 凭据被拒'], ['typesafe_api_key_rejected', 'TypeSafe Key 被拒'],
            ['grok_oauth_credential_revoked', 'Grok 凭据已吊销'], ['grok_oauth_credentials_missing', 'Grok 凭据缺失'],
            ['grok_oauth_entitlement_action_required', 'Grok 需处理订阅权益'], ['grok_oauth_proxy_invalid', 'Grok 代理无效'],
            ['grok_oauth_refresh_transient', 'Grok 刷新临时失败'], ['grok_oauth_provider_config', 'Grok 配置错误'],
            ['grok_oauth_provider_unavailable', 'Grok 服务不可用'], ['grok_oauth_failover_timeout', 'Grok 切换超时']
          ].map(up)
        }
      ]
    },
    {
      id: 'local',
      title: '本服务器报错',
      short: '本地',
      hint: 'yf-mail 自己返回给用户的错误，前缀 local:',
      sections: [
        {
          title: '本服务器拦截（业务错误码）',
          items: [
            ['insufficient_balance', '用户余额不足'], ['usage_limit_exceeded', '用量超限'], ['api_key_quota_exhausted', 'Key 额度 / 限额用完'],
            ['subscription_not_found', '无有效订阅'], ['subscription_invalid', '订阅无效或过期'],
            ['invalid_api_key', 'Key 无效'], ['api_key_required', '未带 Key'], ['api_key_expired', 'Key 已过期'], ['api_key_disabled', 'Key 已停用'],
            ['user_not_found', '用户不存在'], ['user_inactive', '用户已停用'], ['group_deleted', '分组已删除'], ['group_disabled', '分组已停用'],
            ['api_key_in_query_deprecated', 'URL 传 Key 已弃用']
          ].map(local)
        },
        {
          title: '返回给用户的错误类型（type）',
          items: [
            ['upstream_error', '上游失败后的包装错误'], ['overloaded_error', '过载'], ['rate_limit_error', '限流 / 并发超限'],
            ['api_error', '内部错误 / 无可用账号'], ['service_unavailable_error', '服务不可用'], ['timeout_error', '超时'], ['server_error', '服务器错误'],
            ['invalid_request_error', '请求无效'], ['authentication_error', '用户鉴权失败'], ['permission_error', '无权限'],
            ['forbidden_error', '禁止访问'], ['not_found_error', '资源不存在'], ['model_not_found', '模型不存在'],
            ['billing_error', '计费错误'], ['subscription_error', '订阅错误']
          ].map(local)
        },
        {
          title: '返回给用户的状态码',
          items: [
            ['4xx', '全部 4xx'], ['5xx', '全部 5xx'], ['400', '请求无效'], ['401', '鉴权失败'], ['402', '余额不足'], ['403', '禁止访问'],
            ['404', '不存在'], ['429', '限流'], ['500', '内部错误'], ['502', '上游失败'], ['503', '服务不可用'], ['504', '超时'], ['529', '过载']
          ].map(local)
        }
      ]
    },
    {
      id: 'attribution',
      title: '归因分类（yf-mail 判定）',
      short: '归因',
      hint: 'Sub2API 对每条报错的阶段 / 责任方 / 来源判定，前缀 local:',
      sections: [
        {
          title: '判定为上游导致',
          items: [
            ['upstream', '阶段 phase=upstream'], ['account_auth', '阶段 phase=account_auth（上游账号凭据）'],
            ['provider', '责任方 owner=provider'], ['upstream_http', '来源 source=upstream_http']
          ].map(local)
        },
        {
          title: '判定为本服务器 / 用户导致',
          items: [
            ['request', '阶段 phase=request（请求或业务限制）'], ['auth', '阶段 phase=auth（用户 Key 鉴权）'],
            ['routing', '阶段 phase=routing（调度 / 无可用账号）'], ['internal', '阶段 phase=internal（内部错误）'],
            ['client', '责任方 owner=client（用户）'], ['platform', '责任方 owner=platform（本服务器）'],
            ['client_request', '来源 source=client_request'], ['gateway', '来源 source=gateway']
          ].map(local)
        }
      ]
    }
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = { REQUEST_ERROR_CODE_GROUPS };
  else root.REQUEST_ERROR_CODE_GROUPS = REQUEST_ERROR_CODE_GROUPS;
})(typeof window !== 'undefined' ? window : globalThis);
