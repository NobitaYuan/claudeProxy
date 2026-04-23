import 'dotenv/config';

function parseIntSafe(value: string | undefined, defaultVal: number): number {
  const parsed = parseInt(value || '', 10);
  return isNaN(parsed) || parsed < 0 ? defaultVal : parsed;
}

export const config = {
  port: parseIntSafe(process.env.PORT, 3000),

  // 提供者类型: 'glm' (默认)
  providerType: process.env.PROVIDER_TYPE || 'glm',

  // 上游 API（优先读通用变量，回退到 GLM 专用变量）
  apiBase: process.env.API_BASE || process.env.GLM_API_BASE || 'https://open.bigmodel.cn/api/anthropic',
  apiKeys: (process.env.API_KEYS || process.env.GLM_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),

  // 旧字段别名，渐进迁移
  get glmApiBase() { return this.apiBase; },
  get glmApiKeys() { return this.apiKeys; },

  adminToken: process.env.ADMIN_TOKEN || 'admin-secret-token',
  cooldownMs: parseIntSafe(process.env.COOLDOWN_MS, 60000),
  sessionTimeoutMs: parseIntSafe(process.env.SESSION_TIMEOUT_MS, 1800000), // 30 分钟
  dbPath: process.env.DB_PATH || './data/proxy.db',
};
