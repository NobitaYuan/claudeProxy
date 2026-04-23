import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UpstreamSync } from '../../src/stats/upstreamSync.js';
import type { Provider, KeySyncResult } from '../../src/providers/index.js';

const mockRun = vi.fn();
const mockAll = vi.fn((): any[] => []);
const mockGet = vi.fn((): any => ({}));
const mockPrepare = vi.fn(() => ({ run: mockRun, all: mockAll, get: mockGet }));

vi.mock('../../src/stats/database.js', () => ({
  getDb: vi.fn(() => ({
    prepare: mockPrepare,
  })),
}));

function createMockProvider(keys: string[] = ['key1']): Provider {
  return {
    name: 'test-provider',
    apiBase: 'https://test.api.com/api/anthropic',
    apiKeys: keys,
    buildAuthHeader: vi.fn((key: string) => `Bearer ${key}`),
    fetchKeyUsage: vi.fn(),
    extractPrimaryQuota: vi.fn((quotas) => {
      if (quotas.length === 0) return undefined;
      return quotas[0].percentage;
    }),
  } as unknown as Provider;
}

describe('UpstreamSync', () => {
  let mockProvider: Provider;

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockRun.mockClear();
    mockAll.mockClear();
    mockGet.mockClear();
    mockPrepare.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getQuotaHints 返回配额缓存副本', () => {
    const sync = new UpstreamSync(mockProvider);
    const hints = sync.getQuotaHints();
    expect(hints.size).toBe(0);
    // 验证返回的是副本（修改不影响内部）
    hints.set(0, 99);
    expect(sync.getQuotaHints().size).toBe(0);
  });

  it('start/stop 管理定时器不抛异常', () => {
    const sync = new UpstreamSync(mockProvider);
    sync.start();
    sync.stop();
  });

  it('run 成功拉取并持久化数据', async () => {
    const sync = new UpstreamSync(mockProvider);
    const result: KeySyncResult = {
      accountKeyIndex: 0,
      upstreamTokens: 1000,
      upstreamCalls: 10,
      quotas: [{ label: '5小时 Token', percentage: 50 }],
    };
    (mockProvider.fetchKeyUsage as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    await (sync as any).run();

    expect(mockRun).toHaveBeenCalledTimes(1);
    const args = mockRun.mock.calls[0];
    expect(args[1]).toBe(0); // accountKeyIndex
    expect(args[2]).toBe(1000); // upstreamTokens
    expect(args[3]).toBe(10); // upstreamCalls
  });

  it('run 拉取失败后不写入 DB', async () => {
    const sync = new UpstreamSync(mockProvider);
    (mockProvider.fetchKeyUsage as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await (sync as any).run();

    expect(mockRun).not.toHaveBeenCalled();
  });

  it('run 更新配额缓存', async () => {
    const sync = new UpstreamSync(mockProvider);
    const result: KeySyncResult = {
      accountKeyIndex: 0,
      upstreamTokens: 1000,
      upstreamCalls: 10,
      quotas: [{ label: '5小时 Token', percentage: 75 }],
    };
    (mockProvider.fetchKeyUsage as ReturnType<typeof vi.fn>).mockResolvedValue(result);
    (mockProvider.extractPrimaryQuota as ReturnType<typeof vi.fn>).mockReturnValue(75);

    await (sync as any).run();

    expect(sync.getQuotaHints().get(0)).toBe(75);
  });

  it('getLatest 返回最新的校准数据', () => {
    mockAll.mockReturnValueOnce([
      {
        date: '2026-04-22',
        account_key_index: 0,
        upstream_tokens: 1000,
        upstream_calls: 10,
        quotas: '[{"label":"5小时 Token","percentage":50}]',
      },
    ]);

    const sync = new UpstreamSync(mockProvider);
    const result = sync.getLatest();

    expect(result.size).toBe(1);
    expect(result.get(0)?.upstreamTokens).toBe(1000);
    expect(result.get(0)?.upstreamCalls).toBe(10);
    expect(result.get(0)?.quotas).toEqual([{ label: '5小时 Token', percentage: 50 }]);
  });

  it('start 日志包含 provider 名称', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sync = new UpstreamSync(mockProvider);
    sync.start();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('test-provider'));
    sync.stop();
    consoleSpy.mockRestore();
  });
});
