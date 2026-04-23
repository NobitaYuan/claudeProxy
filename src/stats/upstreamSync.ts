import { getDb } from './database.js';
import type { Provider, QuotaDisplay } from '../providers/index.js';

export interface KeyUpstreamData {
  accountKeyIndex: number;
  upstreamTokens: number;
  upstreamCalls: number;
  quotas: QuotaDisplay[];
}

const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

export class UpstreamSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private provider: Provider;
  private quotaCache = new Map<number, number>();

  constructor(provider: Provider) {
    this.provider = provider;
  }

  /** 从内存缓存读取各 key 的主配额百分比，供 AccountBalancer 调度使用 */
  getQuotaHints(): Map<number, number> {
    return new Map(this.quotaCache);
  }

  start() {
    this.run();
    this.timer = setInterval(() => this.run(), FETCH_INTERVAL_MS);
    console.log(`[UpstreamSync] 定时拉取已启动，提供者: ${this.provider.name}，${this.provider.apiKeys.length} 个 key，间隔 ${FETCH_INTERVAL_MS / 1000}s`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getLatest(): Map<number, KeyUpstreamData> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.date, c.account_key_index, c.upstream_tokens, c.upstream_calls, c.quotas
      FROM calibrations c
      INNER JOIN (
        SELECT account_key_index, MAX(created_at) as max_created
        FROM calibrations
        GROUP BY account_key_index
      ) latest ON c.account_key_index = latest.account_key_index AND c.created_at = latest.max_created
    `).all() as { date: string; account_key_index: number; upstream_tokens: number; upstream_calls: number; quotas: string }[];

    const result = new Map<number, KeyUpstreamData>();
    for (const row of rows) {
      result.set(row.account_key_index, {
        accountKeyIndex: row.account_key_index,
        upstreamTokens: row.upstream_tokens,
        upstreamCalls: row.upstream_calls,
        quotas: row.quotas ? JSON.parse(row.quotas) : [],
      });
    }
    return result;
  }

  private async run() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateStr = `${todayStart.getFullYear()}-${String(todayStart.getMonth() + 1).padStart(2, '0')}-${String(todayStart.getDate()).padStart(2, '0')}`;

    const results = await Promise.allSettled(
      this.provider.apiKeys.map((key, index) =>
        this.provider.fetchKeyUsage(key, index, todayStart, now)
      )
    );

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO calibrations (date, account_key_index, upstream_tokens, upstream_calls, quotas)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date, account_key_index) DO UPDATE SET
        upstream_tokens = excluded.upstream_tokens,
        upstream_calls = excluded.upstream_calls,
        quotas = excluded.quotas,
        created_at = datetime('now', 'localtime')
    `);

    let successCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const d = r.value;
        upsert.run(dateStr, d.accountKeyIndex, d.upstreamTokens, d.upstreamCalls, JSON.stringify(d.quotas));
        successCount++;
        // 更新内存配额缓存
        const primaryQuota = this.provider.extractPrimaryQuota(d.quotas);
        if (primaryQuota !== undefined) {
          this.quotaCache.set(d.accountKeyIndex, primaryQuota);
        }
      }
    }
    console.log(`[UpstreamSync] 用量数据已更新 | ${dateStr} | ${successCount}/${this.provider.apiKeys.length} 个 key 成功`);
  }
}
