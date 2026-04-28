import { Hono } from 'hono';
import type { AccountBalancer } from '../proxy/accountBalancer.js';
import type { RequestLog } from '../stats/requestLog.js';
import type { UpstreamSync } from '../stats/upstreamSync.js';
import { config } from '../config.js';

const MAX_QUERY_DAYS = 90;

function parseDays(value: string | undefined): number {
  const parsed = parseInt(value || '7', 10);
  if (isNaN(parsed) || parsed <= 0) return 7;
  return Math.min(parsed, MAX_QUERY_DAYS);
}

// 运行时注入的依赖
let pool: AccountBalancer;
let tracker: RequestLog;
let calibrator: UpstreamSync;

export function initAdminDeps(
  p: AccountBalancer,
  t: RequestLog,
  c: UpstreamSync
) {
  pool = p;
  tracker = t;
  calibrator = c;
}

export const adminRoutes = new Hono()
  // API 认证中间件
  .use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace('Bearer ', '');
    if (!token || token !== config.adminToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  })

  // Account pool status（含上游 token 和配额）
  .get('/accounts', (c) => {
    const accounts = pool.getStatus();
    const usage = tracker.getUsageByAccount();
    const usageMap = new Map(usage.map(u => [u.accountIndex, u]));
    const calibrationMap = calibrator.getLatest();

    const merged = accounts.map(a => {
      const calData = calibrationMap.get(a.index);
      return {
        ...a,
        requestCount: usageMap.get(a.index)?.totalRequests ?? 0,
        todayUpstreamTokens: calData?.upstreamTokens ?? 0,
        todayUpstreamCalls: calData?.upstreamCalls ?? 0,
        quotas: calData?.quotas ?? [],
      };
    });
    return c.json({ accounts: merged });
  })

  // Usage by client IP
  .get('/usage', (c) => {
    const days = parseDays(c.req.query('days'));
    return c.json({ usage: tracker.getUsageByIp(days) });
  })

  // Overall summary
  .get('/usage/summary', (c) => {
    const days = parseDays(c.req.query('days'));
    return c.json({
      summary: tracker.getSummary(days),
      daily: tracker.getDailyBreakdown(days),
    });
  })

  // 校准数据（所有 key 的最新快照）
  .get('/calibration', (c) => {
    const map = calibrator.getLatest();
    const entries = Array.from(map.values());
    return c.json({ calibration: entries });
  });

export type AppType = typeof adminRoutes;
