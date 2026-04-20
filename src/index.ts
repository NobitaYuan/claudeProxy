import os from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { AccountPool } from './proxy/accountPool.js';
import { createProxyHandler } from './proxy/handler.js';
import { initDb } from './stats/db.js';
import { UsageTracker } from './stats/tracker.js';
import { createAdminRoutes } from './admin/routes.js';

type Env = { Variables: { clientIp: string } };

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// Init DB
initDb();
const tracker = new UsageTracker();
const pool = new AccountPool();
const proxyHandler = createProxyHandler(pool, tracker);

const app = new Hono<Env>();

// Inject client IP into context
app.use('*', async (c, next) => {
  const incoming = (c.env as any)?.incoming;
  const ip = incoming?.socket?.remoteAddress?.replace(/::ffff:/, '') || 'unknown';
  c.set('clientIp', ip);
  await next();
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', accounts: config.glmApiKeys.length }));

// Admin routes
app.route('/admin', createAdminRoutes(pool, tracker));

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
console.log('Claude Code config for employees:');
for (const ip of ips) {
  console.log(`  ANTHROPIC_BASE_URL=http://${ip}:${config.port}`);
}
console.log('  ANTHROPIC_API_KEY=placeholder');
console.log('');
serve({ fetch: app.fetch, port: config.port });
