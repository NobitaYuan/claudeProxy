import { config } from '../config.js';

export interface Account {
  index: number;
  apiKey: string;
  status: 'active' | 'cooldown';
  cooldownUntil: number;
}

interface SessionBinding {
  accountIndex: number;
  lastActivity: number;
}

export class AccountPool {
  private accounts: Account[];
  // session_id → 绑定信息，同一 session 粘性绑定同一个 key
  private sessionBindings = new Map<string, SessionBinding>();
  // 各 key 的最高配额百分比（由外部注入）
  private quotaHints = new Map<number, number>();
  // 过期清理定时器
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (config.glmApiKeys.length === 0) {
      throw new Error('GLM_API_KEYS is empty. Configure at least one API key.');
    }
    this.accounts = config.glmApiKeys.map((key, i) => ({
      index: i,
      apiKey: key,
      status: 'active',
      cooldownUntil: 0,
    }));
  }

  /** 启动 session 过期清理定时器 */
  start() {
    const intervalMs = 5 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.evictStale(), intervalMs);
  }

  /** 按 session 粘性获取账户：已有绑定且 active 则复用，否则分配到绑定数最少的账户 */
  getNext(sessionId: string): Account | null {
    this.recoverCooldowns();

    // 已有绑定
    const binding = this.sessionBindings.get(sessionId);
    if (binding !== undefined) {
      const bound = this.accounts[binding.accountIndex];
      if (bound.status === 'active') {
        binding.lastActivity = Date.now();
        return bound;
      }
      // 绑定的账户在冷却中，临时解绑，重新分配
      this.sessionBindings.delete(sessionId);
    }

    // 选绑定数最少的 active 账户
    const candidate = this.leastLoadedAccount();
    if (!candidate) return null;

    this.sessionBindings.set(sessionId, { accountIndex: candidate.index, lastActivity: Date.now() });
    return candidate;
  }

  /** 外部注入各 key 的最高配额百分比，用于分配时跳过即将耗尽的 key */
  setQuotaHints(map: Map<number, number>) {
    this.quotaHints = map;
  }

  /** 将账户标记为冷却状态 */
  cooldown(account: Account, durationMs?: number) {
    account.status = 'cooldown';
    account.cooldownUntil = Date.now() + (durationMs ?? config.cooldownMs);
    console.log(`[Pool] Account #${account.index} cooling down for ${(durationMs ?? config.cooldownMs) / 1000}s`);
  }

  /** 判断 session 是否已有绑定 */
  hasSession(sessionId: string): boolean {
    return this.sessionBindings.has(sessionId);
  }

  /** 获取所有账户状态（管理 API 用） */
  getStatus() {
    const now = Date.now();
    const sessionCounts = new Array(this.accounts.length).fill(0) as number[];
    for (const binding of this.sessionBindings.values()) {
      sessionCounts[binding.accountIndex]++;
    }
    return this.accounts.map((acc, i) => ({
      index: acc.index,
      status: now >= acc.cooldownUntil ? 'active' : acc.status,
      cooldownRemaining: acc.status === 'cooldown' ? Math.max(0, acc.cooldownUntil - now) : 0,
      apiKeySuffix: acc.apiKey.slice(-6),
      sessionCount: sessionCounts[i],
    }));
  }

  /** 淘汰超过阈值的过期 session 绑定 */
  private evictStale() {
    const threshold = Date.now() - config.sessionTimeoutMs;
    let evicted = 0;
    for (const [sid, binding] of this.sessionBindings) {
      if (binding.lastActivity < threshold) {
        this.sessionBindings.delete(sid);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.log(`[Pool] 清理 ${evicted} 个过期 session 绑定（阈值 ${config.sessionTimeoutMs / 1000}s）`);
    }
  }

  /** 恢复已过冷却期的账户 */
  private recoverCooldowns() {
    const now = Date.now();
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && now >= acc.cooldownUntil) {
        acc.status = 'active';
      }
    }
  }

  /** 选配额占用最低的 active 账户；配额差距 ≤5% 时按绑定 session 数分配 */
  private leastLoadedAccount(): Account | null {
    const sessionCounts = new Array(this.accounts.length).fill(0) as number[];
    for (const binding of this.sessionBindings.values()) {
      sessionCounts[binding.accountIndex]++;
    }

    let best: Account | null = null;
    let bestCount = Infinity;
    let bestQuota = Infinity;
    for (const acc of this.accounts) {
      if (acc.status !== 'active') continue;
      const count = sessionCounts[acc.index];
      const quota = this.quotaHints.get(acc.index) ?? 0;

      if (best === null) { best = acc; bestCount = count; bestQuota = quota; continue; }

      const quotaDiff = Math.abs(quota - bestQuota);
      if (quotaDiff > 5) {
        // 配额差距明显，选配额占用更低的
        if (quota < bestQuota) { best = acc; bestCount = count; bestQuota = quota; }
      } else {
        // 配额接近，选 session 数更少的
        if (count < bestCount) { best = acc; bestCount = count; bestQuota = quota; }
      }
    }
    return best;
  }
}
