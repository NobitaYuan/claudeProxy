import { config } from '../config.js';

export interface Account {
  index: number;
  apiKey: string;
  status: 'active' | 'cooldown';
  cooldownUntil: number;
}

export class AccountPool {
  private accounts: Account[];
  // session_id → account index，同一 session 粘性绑定同一个 key
  private sessionBindings = new Map<string, number>();
  // 各 key 的最高配额百分比（由外部注入）
  private quotaHints = new Map<number, number>();

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

  /** 按 session 粘性获取账户：已有绑定且 active 则复用，否则分配到绑定数最少的账户 */
  getNext(sessionId: string): Account | null {
    this.recoverCooldowns();

    // 已有绑定
    const boundIndex = this.sessionBindings.get(sessionId);
    if (boundIndex !== undefined) {
      const bound = this.accounts[boundIndex];
      if (bound.status === 'active') {
        return bound;
      }
      // 绑定的账户在冷却中，临时解绑，重新分配
      this.sessionBindings.delete(sessionId);
    }

    // 选绑定数最少的 active 账户
    const candidate = this.leastLoadedAccount();
    if (!candidate) return null;

    this.sessionBindings.set(sessionId, candidate.index);
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

  /** 获取所有账户状态（管理 API 用） */
  getStatus() {
    const now = Date.now();
    // 统计每个账户的绑定 session 数
    const sessionCounts = new Array(this.accounts.length).fill(0) as number[];
    for (const idx of this.sessionBindings.values()) {
      sessionCounts[idx]++;
    }
    return this.accounts.map((acc, i) => ({
      index: acc.index,
      status: now >= acc.cooldownUntil ? 'active' : acc.status,
      cooldownRemaining: acc.status === 'cooldown' ? Math.max(0, acc.cooldownUntil - now) : 0,
      apiKeySuffix: acc.apiKey.slice(-6),
      sessionCount: sessionCounts[i],
    }));
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

  /** 找到当前绑定 session 数最少的 active 账户（跳过配额 >90% 的 key） */
  private leastLoadedAccount(): Account | null {
    const sessionCounts = new Array(this.accounts.length).fill(0) as number[];
    for (const idx of this.sessionBindings.values()) {
      sessionCounts[idx]++;
    }

    // 先尝试排除配额 >90% 的 key
    const isQuotaExceeded = (acc: Account) => {
      const pct = this.quotaHints.get(acc.index);
      return pct !== undefined && pct > 90;
    };

    let best: Account | null = null;
    let bestCount = Infinity;
    let bestQuota = Infinity;
    let anyCandidate = false;
    for (const acc of this.accounts) {
      if (acc.status !== 'active' || isQuotaExceeded(acc)) continue;
      anyCandidate = true;
      const count = sessionCounts[acc.index];
      const quota = this.quotaHints.get(acc.index) ?? 0;
      if (count < bestCount || (count === bestCount && quota < bestQuota)) {
        best = acc;
        bestCount = count;
        bestQuota = quota;
      }
    }

    // 所有 key 都 >90%，退回原逻辑
    if (!anyCandidate) {
      for (const acc of this.accounts) {
        if (acc.status !== 'active') continue;
        const count = sessionCounts[acc.index];
        const quota = this.quotaHints.get(acc.index) ?? 0;
        if (count < bestCount || (count === bestCount && quota < bestQuota)) {
          best = acc;
          bestCount = count;
          bestQuota = quota;
        }
      }
    }
    return best;
  }
}
