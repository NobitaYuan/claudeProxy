import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UpstreamSync } from '../../src/stats/upstreamSync.js';
import { config } from '../../src/config.js';

const mockRun = vi.fn();
const mockAll = vi.fn((): any[] => []);
const mockGet = vi.fn((): any => ({}));
const mockPrepare = vi.fn(() => ({ run: mockRun, all: mockAll, get: mockGet }));

vi.mock('../../src/stats/database.js', () => ({
  getDb: vi.fn(() => ({
    prepare: mockPrepare,
  })),
}));

describe('UpstreamSync', () => {
  let originalKeys: string[];
  let originalBase: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalKeys = config.glmApiKeys;
    originalBase = config.glmApiBase;
    config.glmApiKeys = ['key1'];
    config.glmApiBase = 'https://test.api.com/api/anthropic';
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    mockRun.mockClear();
    mockAll.mockClear();
    mockGet.mockClear();
    mockPrepare.mockClear();
  });

  afterEach(() => {
    config.glmApiKeys = originalKeys;
    config.glmApiBase = originalBase;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('getQuotaHints 返回配额缓存副本', () => {
    const sync = new UpstreamSync();
    const hints = sync.getQuotaHints();
    expect(hints.size).toBe(0);
    // 验证返回的是副本（修改不影响内部）
    hints.set(0, 99);
    expect(sync.getQuotaHints().size).toBe(0);
  });

  it('start/stop 管理定时器不抛异常', () => {
    const sync = new UpstreamSync();
    sync.start();
    sync.stop();
    // 无异常即通过
  });

  it('run 成功拉取并持久化数据', async () => {
    const sync = new UpstreamSync();

    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          data: { totalUsage: { totalModelCallCount: 10, totalTokensUsage: 1000 } },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          data: { level: 'free', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 50 }] },
        }), { status: 200 }),
      );

    await (sync as any).run();

    expect(mockRun).toHaveBeenCalledTimes(1);
    const args = mockRun.mock.calls[0];
    expect(args[1]).toBe(0); // accountKeyIndex
    expect(args[2]).toBe(1000); // upstreamTokens
    expect(args[3]).toBe(10); // upstreamCalls
  });

  it('run 拉取失败后不写入 DB', async () => {
    const sync = new UpstreamSync();
    mockFetch.mockRejectedValue(new Error('network error'));

    await (sync as any).run();

    expect(mockRun).not.toHaveBeenCalled();
  });

  it('fetchWithTimeout 超时后返回 null', async () => {
    // AbortController 与 fake timers 交互不可靠，此测试改用真实 timer + stub setTimeout 缩短等待
    vi.useRealTimers();
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', (fn: () => void, _delay: number) => realSetTimeout(fn, 1));

    const sync = new UpstreamSync();
    mockFetch.mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });

    const result = await (sync as any).fetchWithTimeout('https://example.com', {});
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('fetchModelUsage 正确构造 URL 和 headers', async () => {
    const sync = new UpstreamSync();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        data: { totalUsage: { totalModelCallCount: 1, totalTokensUsage: 100 } },
      }), { status: 200 }),
    );

    await (sync as any).fetchModelUsage('my-api-key', new Date(2026, 3, 22, 0, 0, 0), new Date(2026, 3, 22, 23, 59, 59));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://test.api.com/api/monitor/usage/model-usage');
    expect(url).toContain('startTime=');
    expect(url).toContain('endTime=');
    expect(options.headers['Authorization']).toBe('my-api-key');
  });

  it('fetchQuotaLimit 正确构造 URL 和 headers', async () => {
    const sync = new UpstreamSync();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        data: { level: 'free', limits: [] },
      }), { status: 200 }),
    );

    await (sync as any).fetchQuotaLimit('my-api-key');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://test.api.com/api/monitor/usage/quota/limit');
    expect(options.headers['Authorization']).toBe('my-api-key');
  });

  it('fetchForKey 返回合并后的数据', async () => {
    const sync = new UpstreamSync();
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          data: { totalUsage: { totalModelCallCount: 5, totalTokensUsage: 500 } },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          data: { level: 'pro', limits: [{ type: 'TIME_LIMIT', percentage: 30 }] },
        }), { status: 200 }),
      );

    const result = await (sync as any).fetchForKey('key1', 0, new Date(), new Date());

    expect(result).not.toBeNull();
    expect(result.accountKeyIndex).toBe(0);
    expect(result.upstreamTokens).toBe(500);
    expect(result.upstreamCalls).toBe(5);
    expect(result.quotas.level).toBe('pro');
  });

  it('getLatest 返回最新的校准数据', () => {
    mockAll.mockReturnValueOnce([
      {
        date: '2026-04-22',
        account_key_index: 0,
        upstream_tokens: 1000,
        upstream_calls: 10,
        quotas: '{"level":"free"}',
      },
    ]);

    const sync = new UpstreamSync();
    const result = sync.getLatest();

    expect(result.size).toBe(1);
    expect(result.get(0)?.upstreamTokens).toBe(1000);
    expect(result.get(0)?.upstreamCalls).toBe(10);
    expect(result.get(0)?.quotas?.level).toBe('free');
  });

  it('API 返回非 200 时返回 null', async () => {
    const sync = new UpstreamSync();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );

    const result = await (sync as any).fetchForKey('key1', 0, new Date(), new Date());
    expect(result).toBeNull();
  });

  it('API 返回 success=false 时返回 null', async () => {
    const sync = new UpstreamSync();
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, data: null }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, data: null }), { status: 200 }),
      );

    const result = await (sync as any).fetchForKey('key1', 0, new Date(), new Date());
    expect(result).toBeNull();
  });
});
