import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AccountBalancer, Account } from '../../src/proxy/accountBalancer.js';
import type { RequestLog } from '../../src/stats/requestLog.js';
import { createProxyHandler } from '../../src/proxy/proxy.js';
import { config } from '../../src/config.js';
import { eventBus } from '../../src/admin/events.js';

vi.mock('../../src/admin/events.js', () => ({
  eventBus: {
    emitProxyEvent: vi.fn(),
  },
}));

function createMockPool(overrides?: Partial<AccountBalancer>): AccountBalancer {
  const defaultAccount: Account = { index: 0, apiKey: 'test-api-key-0', status: 'active', cooldownUntil: 0 };
  return {
    getNext: vi.fn(() => defaultAccount),
    hasSession: vi.fn(() => false),
    cooldown: vi.fn(),
    getStatus: vi.fn(() => []),
    ...overrides,
  } as unknown as AccountBalancer;
}

function createMockTracker(): RequestLog {
  return {
    record: vi.fn(),
    flush: vi.fn(),
    stop: vi.fn(),
    getUsageByIp: vi.fn(),
    getSummary: vi.fn(),
    getUsageByAccount: vi.fn(),
    getDailyBreakdown: vi.fn(),
  } as unknown as RequestLog;
}

function createTestApp(handler: ReturnType<typeof createProxyHandler>) {
  const app = new Hono<{ Variables: { clientIp: string } }>();
  app.use('*', async (c, next) => {
    c.set('clientIp', '127.0.0.1');
    await next();
  });
  app.post('/v1/messages', handler);
  return app;
}

function createRequestBody(overrides?: Record<string, unknown>) {
  return JSON.stringify({
    model: 'claude-3-opus-20240229',
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { user_id: JSON.stringify({ session_id: 'test-session-123' }) },
    ...overrides,
  });
}

describe('createProxyHandler', () => {
  let originalBase: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalBase = config.glmApiBase;
    config.glmApiBase = 'https://test.api.com';
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    config.glmApiBase = originalBase;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('正常 JSON 响应直接转发', async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req-1' },
      }),
    );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('request-id')).toBe('req-1');
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  it('从 metadata.user_id 正确提取 session_id', async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(pool.getNext).toHaveBeenCalledWith('test-session-123');
  });

  it('429 触发重试并解析 Retry-After 秒数', async () => {
    const accounts: Account[] = [
      { index: 0, apiKey: 'key0', status: 'active', cooldownUntil: 0 },
      { index: 1, apiKey: 'key1', status: 'active', cooldownUntil: 0 },
    ];

    const pool = createMockPool({
      getNext: vi.fn(() => {
        // 模拟真实行为：account0 被 cooldown 后返回 account1
        if (accounts[0].status === 'cooldown') return accounts[1];
        return accounts[0];
      }),
      hasSession: vi.fn(() => false),
      cooldown: vi.fn((acc: Account) => {
        acc.status = 'cooldown';
      }),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '5' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(pool.cooldown).toHaveBeenCalledTimes(1);
    expect(pool.cooldown).toHaveBeenCalledWith(accounts[0], 5000);
  });

  it('429 触发重试并解析 Retry-After HTTP-date', async () => {
    const accounts: Account[] = [
      { index: 0, apiKey: 'key0', status: 'active', cooldownUntil: 0 },
      { index: 1, apiKey: 'key1', status: 'active', cooldownUntil: 0 },
    ];

    const pool = createMockPool({
      getNext: vi.fn(() => {
        if (accounts[0].status === 'cooldown') return accounts[1];
        return accounts[0];
      }),
      hasSession: vi.fn(() => false),
      cooldown: vi.fn((acc: Account) => {
        acc.status = 'cooldown';
      }),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    const futureDate = new Date(Date.now() + 30000).toUTCString();
    mockFetch
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': futureDate } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(pool.cooldown).toHaveBeenCalledTimes(1);
    // cooldown 应被传入约 30s 的毫秒数（允许 1s 误差）
    const cooldownMs = (pool.cooldown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(cooldownMs).toBeGreaterThan(28000);
    expect(cooldownMs).toBeLessThanOrEqual(30000);
  });

  it('429 超过 MAX_RETRIES 后返回 502', async () => {
    const pool = createMockPool({
      getNext: vi.fn(() => ({ index: 0, apiKey: 'key0', status: 'active' as const, cooldownUntil: 0 })),
      cooldown: vi.fn(),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('max_retries_exceeded');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('网络异常触发重试，最后一次返回 502', async () => {
    const pool = createMockPool({
      getNext: vi.fn(() => ({ index: 0, apiKey: 'key0', status: 'active' as const, cooldownUntil: 0 })),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockRejectedValue(new Error('network down'));

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('upstream_error');
    expect(json.message).toBe('Error: network down');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('SSE 流式响应正确转发', async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello\n\n'));
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const body = await res.text();
    expect(body).toBe('data: hello\n\n');
  });

  it('请求头正确处理', async () => {
    const pool = createMockPool();
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '1.2.3.4',
      },
      body: createRequestBody(),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [string, { headers: Headers }];
    const headers = options.headers;
    expect(headers.get('authorization')).toBe('Bearer test-api-key-0');
    expect(headers.get('host')).toBe('test.api.com');
    expect(headers.has('x-forwarded-for')).toBe(false);
    expect(headers.has('x-real-ip')).toBe(false);
  });

  it('所有账户冷却时返回 503', async () => {
    const pool = createMockPool({
      getNext: vi.fn(() => null),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody(),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('all_accounts_rate_limited');
  });

  it('新会话绑定事件被正确触发', async () => {
    const pool = createMockPool({
      hasSession: vi.fn(() => false),
    });
    const tracker = createMockTracker();
    const app = createTestApp(createProxyHandler(pool, tracker));

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createRequestBody({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    });

    expect(eventBus.emitProxyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bind',
        accountIndex: 0,
        sessionId: 'test-session', // 前 12 位
        model: 'claude-3-opus-20240229',
        contentTypes: ['text'],
      }),
    );
  });
});
