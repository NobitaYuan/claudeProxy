import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { AccountBalancer } from './proxy/accountBalancer.js';
import { createProxyHandler } from './proxy/proxy.js';
import { initDb } from './stats/database.js';
import { RequestLog } from './stats/requestLog.js';
import { UpstreamSync } from './stats/upstreamSync.js';
import { createAdminRoutes } from './admin/routes.js';
import { DASHBOARD_HTML } from './admin/dashboard.js';
import { eventBus } from './admin/events.js';
import { getLocalIPs } from './utils/tools.js';

// Init DB
initDb();
const requestLog = new RequestLog();
const upstreamSync = new UpstreamSync();
const accountBalancer = new AccountBalancer(upstreamSync);
accountBalancer.start();
upstreamSync.start();
const proxyHandler = createProxyHandler(accountBalancer, requestLog);

const app = new Hono<{ Variables: { clientIp: string } }>();

// Inject client IP into context
app.use('*', async (c, next) => {
  const incoming = (c.env as any)?.incoming;
  const ip = incoming?.socket?.remoteAddress?.replace(/::ffff:/, '') || 'unknown';
  c.set('clientIp', ip);
  await next();
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', accounts: config.glmApiKeys.length }));

// 管理面板页面（无需认证）
app.get('/admin/dashboard', (c) => c.html(DASHBOARD_HTML));
app.get('/admin/', (c) => c.redirect('/admin/dashboard'));
app.get('/admin/events', (c) => eventBus.handler(c));

// Admin API routes
app.route('/admin', createAdminRoutes(accountBalancer, requestLog, upstreamSync));

// Proxy: forward all /v1/* requests
app.all('/v1/*', proxyHandler);

// Start server
const ips = getLocalIPs();
console.log('');
console.log('=== ClaudeProxy Started ===');
console.log(`  Port:     ${config.port}`);
console.log(`  Accounts: ${config.glmApiKeys.length}`);
console.log(`  Upstream: ${config.glmApiBase}`);
console.log(`  IPs:      ${ips.join(', ')}`);
console.log('');
console.log('Dashboard:');
for (const ip of ips) {
  console.log(`  http://${ip}:${config.port}/admin/dashboard`);
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
