import 'dotenv/config';

function parseIntSafe(value: string | undefined, defaultVal: number): number {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) || parsed < 0 ? defaultVal : parsed;
}

export const config = {
  port: parseIntSafe(process.env.PORT, 3000),
  glmApiBase: process.env.GLM_API_BASE || 'https://open.bigmodel.cn/api/anthropic',
  glmApiKeys: (process.env.GLM_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
  adminToken: process.env.ADMIN_TOKEN || 'admin-secret-token',
  cooldownMs: parseIntSafe(process.env.COOLDOWN_MS, 60000),
  sessionTimeoutMs: parseIntSafe(process.env.SESSION_TIMEOUT_MS, 1800000), // 30 分钟
  dbPath: process.env.DB_PATH || './data/proxy.db',
};
