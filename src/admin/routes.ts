import { Hono } from 'hono';
import type { AccountBalancer } from '../proxy/accountBalancer.js';
import type { RequestLog } from '../stats/requestLog.js';
import type { UpstreamSync, KeyUpstreamData } from '../stats/upstreamSync.js';
import { config } from '../config.js';

const MAX_QUERY_DAYS = 90;

function parseDays(value: string | undefined): number {
  const parsed = parseInt(value || '7', 10);
  if (isNaN(parsed) || parsed <= 0) return 7;
  return Math.min(parsed, MAX_QUERY_DAYS);
}

/** 从配额 limits 中提取三类百分比 */
function extractQuotaPercentages(quotas: KeyUpstreamData['quotas']): { monthly: number | null; fiveHour: number | null; weekly: number | null } {
  const result = { monthly: null as number | null, fiveHour: null as number | null, weekly: null as number | null };
  if (!quotas?.limits) return result;
  for (const l of quotas.limits) {
    if (l.type === 'TIME_LIMIT') {
      result.monthly = l.percentage;
    } else if (l.type === 'TOKENS_LIMIT') {
      const unit = l.unit;
      if (unit === 3) result.fiveHour = l.percentage;
      else if (unit === 6) result.weekly = l.percentage;
    }
  }
  return result;
}

export function createAdminRoutes(pool: AccountBalancer, tracker: RequestLog, calibrator: UpstreamSync) {
  const admin = new Hono();

  // API 认证中间件
  admin.use('*', async (c, next) => {
    const token = c.req.header('authorization')?.replace('Bearer ', '');
    if (!token || token !== config.adminToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  // Account pool status（含上游 token 和配额百分比）
  admin.get('/accounts', (c) => {
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
        quotas: calData ? extractQuotaPercentages(calData.quotas) : { monthly: null, fiveHour: null, weekly: null },
      };
    });
    return c.json({ accounts: merged });
  });

  // Usage by client IP
  admin.get('/usage', (c) => {
    const days = parseDays(c.req.query('days'));
    return c.json({ usage: tracker.getUsageByIp(days) });
  });

  // Overall summary
  admin.get('/usage/summary', (c) => {
    const days = parseDays(c.req.query('days'));
    return c.json({
      summary: tracker.getSummary(days),
      daily: tracker.getDailyBreakdown(days),
    });
  });

  // 校准数据（所有 key 的最新快照）
  admin.get('/calibration', (c) => {
    const map = calibrator.getLatest();
    const entries = Array.from(map.values());
    return c.json({ calibration: entries });
  });

  return admin;
}
