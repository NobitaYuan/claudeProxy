import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { createProvider } from './providers/index.js';
import { AccountBalancer } from './proxy/accountBalancer.js';
import { createProxyHandler } from './proxy/proxy.js';
import { initDb } from './stats/database.js';
import { RequestLog } from './stats/requestLog.js';
import { UpstreamSync } from './stats/upstreamSync.js';
import { adminRoutes, initAdminDeps } from './admin/routes.js';
import { DASHBOARD_HTML } from './admin/dashboard.js';
import { eventBus } from './admin/events.js';
import docs from './admin/docs.js';
import { getLocalIPs } from './utils/tools.js';

// 初始化
initDb();
const requestLog = new RequestLog();
const provider = createProvider(config.providerType, config.apiBase, config.apiKeys);
const upstreamSync = new UpstreamSync(provider);
const accountBalancer = new AccountBalancer(upstreamSync);
accountBalancer.start();
upstreamSync.start();
const proxyHandler = createProxyHandler(accountBalancer, requestLog, provider);

const app = new Hono<{ Variables: { clientIp: string } }>();

// CORS
app.use('/admin/*', cors());

// 注入客户端 IP
app.use('*', async (c, next) => {
  const incoming = (c.env as any)?.incoming;
  const ip = incoming?.socket?.remoteAddress?.replace(/::ffff:/, '') || 'unknown';
  c.set('clientIp', ip);
  await next();
});

// 健康检查
app.get('/health', (c) => c.json({ status: 'ok', accounts: config.apiKeys.length, provider: provider.name }));

// 管理面板页面（无需认证）
app.get('/admin/dashboard', (c) => c.html(DASHBOARD_HTML));
app.get('/admin/', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/events', (c) => eventBus.handler(c));

// API 文档（无需认证，必须在 adminRoutes 之前挂载）
initAdminDeps(accountBalancer, requestLog, upstreamSync);
app.route('/admin/docs', docs);

// Admin API（需要 Bearer 认证）
app.route('/admin', adminRoutes);

// 代理：转发所有 /v1/* 请求
app.all('/v1/*', proxyHandler);

// 启动服务
const ips = getLocalIPs();
console.log('');
console.log('=== ClaudeProxy Started ===');
console.log(`  Port:     ${config.port}`);
console.log(`  Provider: ${provider.name}`);
console.log(`  Accounts: ${config.apiKeys.length}`);
console.log(`  Upstream: ${config.apiBase}`);
console.log(`  IPs:      ${ips.join(', ')}`);
console.log('');
console.log('Dashboard:');
for (const ip of ips) {
  console.log(`  http://${ip}:${config.port}/admin/dashboard`);
}
console.log('');
console.log('Docs:');
for (const ip of ips) {
  console.log(`  http://${ip}:${config.port}/admin/docs`);
}
console.log('');
console.log('Claude Code config for employees:');
for (const ip of ips) {
  console.log(`  ANTHROPIC_BASE_URL=http://${ip}:${config.port}`);
}
console.log('  ANTHROPIC_API_KEY=placeholder');
console.log('');

serve({ fetch: app.fetch, port: config.port });

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n[Shutdown] 收到 SIGINT，正在优雅关闭...');
  requestLog.stop();
  upstreamSync.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] 收到 SIGTERM，正在优雅关闭...');
  requestLog.stop();
  upstreamSync.stop();
  process.exit(0);
});
