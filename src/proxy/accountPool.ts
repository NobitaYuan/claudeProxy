import { config } from '../config.js';

export interface Account {
  index: number;
  apiKey: string;
  status: 'active' | 'cooldown';
  cooldownUntil: number;
  requestCount: number;
  tokenUsed: number;
}

export class AccountPool {
  private accounts: Account[];
  private nextIndex = 0;

  constructor() {
    if (config.glmApiKeys.length === 0) {
      throw new Error('GLM_API_KEYS is empty. Configure at least one API key.');
    }
    this.accounts = config.glmApiKeys.map((key, i) => ({
      index: i,
      apiKey: key,
      status: 'active',
      cooldownUntil: 0,
      requestCount: 0,
      tokenUsed: 0,
    }));
  }

  /** Get next available account using round-robin, skipping cooldown accounts */
  getNext(): Account | null {
    const now = Date.now();
    // Recover cooled-down accounts
    for (const acc of this.accounts) {
      if (acc.status === 'cooldown' && now >= acc.cooldownUntil) {
        acc.status = 'active';
      }
    }

    // Try each account once
    for (let i = 0; i < this.accounts.length; i++) {
      const acc = this.accounts[this.nextIndex % this.accounts.length];
      this.nextIndex++;
      if (acc.status === 'active') {
        return acc;
      }
    }

    return null; // All in cooldown
  }

  /** Mark an account as cooldown after rate limit */
  cooldown(account: Account, durationMs?: number) {
    account.status = 'cooldown';
    account.cooldownUntil = Date.now() + (durationMs ?? config.cooldownMs);
    console.log(`[Pool] Account #${account.index} cooling down for ${(durationMs ?? config.cooldownMs) / 1000}s`);
  }

  /** Record usage for an account */
  recordUsage(account: Account, inputTokens: number, outputTokens: number) {
    account.requestCount++;
    account.tokenUsed += inputTokens + outputTokens;
  }

  /** Get all accounts status (for admin API) */
  getStatus() {
    const now = Date.now();
    return this.accounts.map(acc => ({
      index: acc.index,
      status: now >= acc.cooldownUntil ? 'active' : acc.status,
      cooldownRemaining: acc.status === 'cooldown' ? Math.max(0, acc.cooldownUntil - now) : 0,
      requestCount: acc.requestCount,
      tokenUsed: acc.tokenUsed,
      apiKeySuffix: acc.apiKey.slice(-6),
    }));
  }
}
