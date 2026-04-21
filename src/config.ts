import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  glmApiBase: process.env.GLM_API_BASE || 'https://open.bigmodel.cn/api/anthropic',
  glmApiKeys: (process.env.GLM_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
  adminToken: process.env.ADMIN_TOKEN || 'admin-secret-token',
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '60000'),
  sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS || '1800000'), // 30 分钟
  dbPath: process.env.DB_PATH || './data/proxy.db',
};
