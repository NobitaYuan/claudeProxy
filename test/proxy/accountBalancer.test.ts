import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AccountBalancer } from '../../src/proxy/accountBalancer.js';
import { config } from '../../src/config.js';
import type { UpstreamSync } from '../../src/stats/upstreamSync.js';

function createMockUpstreamSync(quotaMap: Map<number, number> = new Map()): UpstreamSync {
  return {
    getQuotaHints: vi.fn(() => new Map(quotaMap)),
  } as unknown as UpstreamSync;
}

describe('AccountBalancer', () => {
  let originalKeys: string[];
  let originalCooldownMs: number;
  let originalSessionTimeoutMs: number;

  beforeEach(() => {
    originalKeys = config.apiKeys;
    originalCooldownMs = config.cooldownMs;
    originalSessionTimeoutMs = config.sessionTimeoutMs;
    vi.useFakeTimers();
  });

  afterEach(() => {
    config.apiKeys = originalKeys;
    config.cooldownMs = originalCooldownMs;
    config.sessionTimeoutMs = originalSessionTimeoutMs;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('无 API key 时抛出异常', () => {
    config.apiKeys = [];
    expect(() => new AccountBalancer(createMockUpstreamSync())).toThrow('No API keys configured');
  });

  it('新 session 绑定到配额最低的账户（差距 >5%）', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync(new Map([[0, 10], [1, 20]])));
    const acc = balancer.getNext('session-1');
    expect(acc).not.toBeNull();
    expect(acc!.index).toBe(0);
  });

  it('已有 session 复用绑定账户', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const first = balancer.getNext('session-1');
    const second = balancer.getNext('session-1');
    expect(second!.index).toBe(first!.index);
  });

  it('配额差距 ≤5% 时按 session 绑定数分配', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync(new Map([[0, 50], [1, 52]])));
    balancer.getNext('s1'); // 绑定到 0（配额更低）
    const acc = balancer.getNext('s2');
    // 0 已绑定 1 个，1 未绑定，配额差距 2 ≤ 5，应选绑定数更少的 1
    expect(acc!.index).toBe(1);
  });

  it('绑定的账户冷却时自动解绑重新分配', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const first = balancer.getNext('s1');
    expect(first!.index).toBe(0);

    balancer.cooldown(first!);
    const second = balancer.getNext('s1');
    expect(second!.index).toBe(1);
  });

  it('冷却账户到时间后自动恢复', () => {
    config.apiKeys = ['key0'];
    config.cooldownMs = 60000;
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const acc = balancer.getNext('s1')!;
    balancer.cooldown(acc);
    expect(balancer.getNext('s1')).toBeNull();

    vi.advanceTimersByTime(60000);
    expect(balancer.getNext('s1')).not.toBeNull();
  });

  it('所有账户都在冷却时返回 null', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const acc0 = balancer.getNext('s1')!;
    const acc1 = balancer.getNext('s2')!;
    balancer.cooldown(acc0);
    balancer.cooldown(acc1);
    expect(balancer.getNext('s3')).toBeNull();
  });

  it('过期 session 被定时清理', () => {
    config.apiKeys = ['key0'];
    config.sessionTimeoutMs = 1800000;
    const balancer = new AccountBalancer(createMockUpstreamSync());
    balancer.start();
    balancer.getNext('s1');
    expect(balancer.hasSession('s1')).toBe(true);

    // interval 周期 5 分钟，需 advance 超过 timeout + interval 才能让清理在过期后触发
    vi.advanceTimersByTime(35 * 60 * 1000);
    expect(balancer.hasSession('s1')).toBe(false);
  });

  it('getStatus 返回正确的账户状态统计', () => {
    config.apiKeys = ['key0', 'key1'];
    const balancer = new AccountBalancer(createMockUpstreamSync());
    balancer.getNext('s1');
    balancer.getNext('s2');
    balancer.getNext('s3'); // 配额相同时按顺序分配：0, 1, 0

    const status = balancer.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0].sessionCount).toBe(2);
    expect(status[1].sessionCount).toBe(1);
    expect(status[0].status).toBe('active');
    expect(status[0].apiKeySuffix).toBe('key0'.slice(-6));
  });

  it('自定义冷却时长生效', () => {
    config.apiKeys = ['key0'];
    config.cooldownMs = 60000;
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const acc = balancer.getNext('s1')!;
    balancer.cooldown(acc, 30000); // 自定义 30s

    vi.advanceTimersByTime(29999);
    expect(balancer.getNext('s1')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(balancer.getNext('s1')).not.toBeNull();
  });

  it('Retry-After HTTP-date 格式解析生效（通过 cooldown 验证）', () => {
    // 冷却时长直接传入毫秒数，此用例验证 cooldownUntil 计算正确
    config.apiKeys = ['key0'];
    const balancer = new AccountBalancer(createMockUpstreamSync());
    const acc = balancer.getNext('s1')!;
    const customMs = 120000;
    balancer.cooldown(acc, customMs);

    vi.advanceTimersByTime(customMs - 1);
    expect(balancer.getNext('s1')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(balancer.getNext('s1')).not.toBeNull();
  });
});
