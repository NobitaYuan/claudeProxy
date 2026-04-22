import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createAdminRoutes } from '../../src/admin/routes.js';
import { config } from '../../src/config.js';
import type { AccountBalancer } from '../../src/proxy/accountBalancer.js';
import type { RequestLog } from '../../src/stats/requestLog.js';
import type { UpstreamSync } from '../../src/stats/upstreamSync.js';

function createMockPool(): AccountBalancer {
  return {
    getNext: vi.fn(),
    hasSession: vi.fn(),
    cooldown: vi.fn(),
    getStatus: vi.fn(() => [
      { index: 0, status: 'active', cooldownRemaining: 0, apiKeySuffix: 'abc123', sessionCount: 2 },
      { index: 1, status: 'cooldown', cooldownRemaining: 30000, apiKeySuffix: 'def456', sessionCount: 0 },
    ]),
  } as unknown as AccountBalancer;
}

function createMockTracker(): RequestLog {
  return {
    record: vi.fn(),
    flush: vi.fn(),
    stop: vi.fn(),
    getUsageByIp: vi.fn(() => [
      { client_ip: '1.1.1.1', total_requests: 5, first_request: '2026-04-22', last_request: '2026-04-22' },
    ]),
    getSummary: vi.fn(() => ({ total_requests: 10, unique_clients: 2 })),
    getUsageByAccount: vi.fn(() => [{ accountIndex: 0, totalRequests: 8 }, { accountIndex: 1, totalRequests: 2 }]),
    getDailyBreakdown: vi.fn(() => [{ date: '2026-04-22', total_requests: 10 }]),
  } as unknown as RequestLog;
}

function createMockCalibrator(): UpstreamSync {
  return {
    getLatest: vi.fn(() => new Map([
      [0, { accountKeyIndex: 0, upstreamTokens: 1000, upstreamCalls: 10, quotas: { level: 'free', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 50 }] } }],
    ])),
    getQuotaHints: vi.fn(() => new Map()),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as UpstreamSync;
}

function createTestApp(pool: AccountBalancer, tracker: RequestLog, calibrator: UpstreamSync) {
  const app = new Hono();
  app.route('/admin', createAdminRoutes(pool, tracker, calibrator));
  return app;
}

describe('Admin Routes', () => {
  let originalToken: string;

  beforeEach(() => {
    originalToken = config.adminToken;
    config.adminToken = 'test-admin-token';
  });

  afterEach(() => {
    config.adminToken = originalToken;
    vi.restoreAllMocks();
  });

  it('无 token 返回 401', async () => {
    const app = createTestApp(createMockPool(), createMockTracker(), createMockCalibrator());
    const res = await app.request('/admin/accounts');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  it('错误 token 返回 401', async () => {
    const app = createTestApp(createMockPool(), createMockTracker(), createMockCalibrator());
    const res = await app.request('/admin/accounts', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('/accounts 返回合并后的账户数据', async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const calibrator = createMockCalibrator();
    const app = createTestApp(pool, tracker, calibrator);

    const res = await app.request('/admin/accounts', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accounts).toHaveLength(2);
    expect(json.accounts[0].requestCount).toBe(8);
    expect(json.accounts[0].todayUpstreamTokens).toBe(1000);
    expect(json.accounts[0].quotas.fiveHour).toBe(50);
    expect(json.accounts[1].status).toBe('cooldown');
    expect(json.accounts[1].cooldownRemaining).toBe(30000);
  });

  it('/usage 返回 IP 用量数据', async () => {
    const tracker = createMockTracker();
    const app = createTestApp(createMockPool(), tracker, createMockCalibrator());

    const res = await app.request('/admin/usage?days=14', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(res.status).toBe(200);
    expect(tracker.getUsageByIp).toHaveBeenCalledWith(14);
    const json = await res.json();
    expect(json.usage).toHaveLength(1);
    expect(json.usage[0].client_ip).toBe('1.1.1.1');
  });

  it('/usage/summary 返回汇总和日 breakdown', async () => {
    const tracker = createMockTracker();
    const app = createTestApp(createMockPool(), tracker, createMockCalibrator());

    const res = await app.request('/admin/usage/summary', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(res.status).toBe(200);
    expect(tracker.getSummary).toHaveBeenCalledWith(7);
    expect(tracker.getDailyBreakdown).toHaveBeenCalledWith(7);
    const json = await res.json();
    expect(json.summary.total_requests).toBe(10);
    expect(json.daily).toHaveLength(1);
  });

  it('/calibration 返回校准数据', async () => {
    const calibrator = createMockCalibrator();
    const app = createTestApp(createMockPool(), createMockTracker(), calibrator);

    const res = await app.request('/admin/calibration', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(res.status).toBe(200);
    expect(calibrator.getLatest).toHaveBeenCalled();
    const json = await res.json();
    expect(json.calibration).toHaveLength(1);
    expect(json.calibration[0].upstreamTokens).toBe(1000);
  });

  it('days 参数超过 90 被限制为 90', async () => {
    const tracker = createMockTracker();
    const app = createTestApp(createMockPool(), tracker, createMockCalibrator());

    await app.request('/admin/usage?days=365', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(tracker.getUsageByIp).toHaveBeenCalledWith(90);
  });

  it('days 参数非数字时回退默认值 7', async () => {
    const tracker = createMockTracker();
    const app = createTestApp(createMockPool(), tracker, createMockCalibrator());

    await app.request('/admin/usage?days=abc', {
      headers: { authorization: 'Bearer test-admin-token' },
    });

    expect(tracker.getUsageByIp).toHaveBeenCalledWith(7);
  });
});
