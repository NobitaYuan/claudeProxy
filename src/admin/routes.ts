import { Hono } from 'hono';
import type { AccountPool } from '../proxy/accountPool.js';
import type { UsageTracker } from '../stats/tracker.js';
import { config } from '../config.js';

export function createAdminRoutes(pool: AccountPool, tracker: UsageTracker) {
  const admin = new Hono();

  // Admin auth middleware
  admin.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace('Bearer ', '');
    if (!token || token !== config.adminToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // Account pool status
  admin.get('/accounts', (c) => {
    return c.json({ accounts: pool.getStatus() });
  });

  // Usage by client IP
  admin.get('/usage', (c) => {
    const days = parseInt(c.req.query('days') || '7');
    return c.json({ usage: tracker.getUsageByIp(days) });
  });

  // Overall summary
  admin.get('/usage/summary', (c) => {
    const days = parseInt(c.req.query('days') || '7');
    return c.json({
      summary: tracker.getSummary(days),
      daily: tracker.getDailyBreakdown(days),
    });
  });

  return admin;
}
