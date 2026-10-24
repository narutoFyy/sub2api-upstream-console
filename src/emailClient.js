const { z } = require('zod');
const nodemailer = require('nodemailer');
const repo = require('./repository');

const EMAIL_SETTINGS_KEY = 'smtp_settings';
const address = z.string().trim().max(254).email();
const emailSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/, '请输入 SMTP 主机名，不要包含协议或端口'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  user: z.string().trim().max(254).default(''),
  password: z.string().max(2000).optional(),
  from: address,
  to: z.array(address).min(1).max(20),
  timeout_ms: z.number().int().min(1000).max(60000).default(10000)
}).strict();

function readEmailSettings(repository = repo) {
  const raw = repository.getSecretSetting(EMAIL_SETTINGS_KEY);
  if (!raw) return null;
  return emailSettingsSchema.parse(JSON.parse(raw));
}

function emailStatus(dependencies = {}) {
  const settings = readEmailSettings(dependencies.repo || repo);
  if (!settings) return { configured: false, enabled: false };
  const { password, ...safe } = settings;
  return { ...safe, configured: true, has_password: Boolean(password) };
}

function saveEmailSettings(input, repository = repo) {
  const parsed = emailSettingsSchema.parse(input);
  const previous = readEmailSettings(repository);
  const settings = { ...parsed, password: parsed.password || previous?.password || '' };
  if (Boolean(settings.user) !== Boolean(settings.password)) {
    throw Object.assign(new Error('SMTP 用户名和密码／授权码需同时填写；无认证服务器可同时留空'), { status: 422 });
  }
  settings.to = [...new Set(settings.to)];
  repository.setSecretSetting(EMAIL_SETTINGS_KEY, JSON.stringify(settings));
  return emailStatus({ repo: repository });
}

function emailError(error) {
  const detail = {
    EAUTH: '认证失败，请检查用户名和 SMTP 授权码',
    ETIMEDOUT: '连接超时，请检查服务器地址、端口和防火墙',
    ECONNECTION: '连接失败，请检查服务器地址和端口',
    ESOCKET: '连接或 TLS 握手失败，请检查端口与加密方式',
    ETLS: 'TLS 握手失败，请检查加密方式和服务器证书',
    EENVELOPE: '发件人或收件人被拒绝，请检查邮箱地址和发送权限',
    EPARTIAL: '部分收件人被拒绝，请检查收件地址和发送权限'
  }[error.code] || '发送失败，请检查 SMTP 配置和邮件服务状态';
  return Object.assign(new Error(`邮件${detail}`), { status: 502 });
}

async function sendEmail({ title, content }, dependencies = {}) {
  const settings = readEmailSettings(dependencies.repo || repo);
  if (!settings || (!settings.enabled && !dependencies.allowDisabled)) {
    throw Object.assign(new Error('邮箱提醒尚未配置或未启用'), { status: 422 });
  }
  const createTransport = dependencies.createTransport || nodemailer.createTransport;
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
    connectionTimeout: settings.timeout_ms,
    greetingTimeout: settings.timeout_ms,
    socketTimeout: settings.timeout_ms,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  try {
    const result = await transport.sendMail({
      from: settings.from,
      to: settings.to,
      subject: String(title).replace(/[\r\n]+/g, ' ').slice(0, 200),
      text: String(content)
    });
    if (result.rejected?.length || !result.accepted?.length) {
      throw Object.assign(new Error('Recipients rejected'), { code: 'EPARTIAL' });
    }
    return { ok: true, accepted: result.accepted.length, message: '邮件服务器已接收，请检查收件箱或垃圾邮件' };
  } catch (error) {
    throw emailError(error);
  } finally {
    transport.close();
  }
}

module.exports = { EMAIL_SETTINGS_KEY, readEmailSettings, saveEmailSettings, emailStatus, sendEmail };
