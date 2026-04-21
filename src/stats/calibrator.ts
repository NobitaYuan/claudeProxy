import { config } from '../config.js';
import { getDb } from './db.js';

interface UpstreamModelUsage {
  totalUsage: {
    totalModelCallCount: number;
    totalTokensUsage: number;
  };
}

export interface QuotaLimit {
  limits: {
    type: string;
    percentage: number;
    currentValue?: number;
    usage?: number;
    usageDetails?: { modelCode: string; usage: number }[];
    nextResetTime: number;
  }[];
  level: string;
}

export interface KeyUpstreamData {
  accountKeyIndex: number;
  upstreamTokens: number;
  upstreamCalls: number;
  quotas: QuotaLimit | null;
}

const FETCH_INTERVAL_MS = 30 * 60 * 1000;

export class Calibrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private keys: string[];
  private baseUrl: string;
  private onQuotaUpdate?: (hints: Map<number, number>) => void;

  constructor() {
    this.keys = config.glmApiKeys;
    const parsed = new URL(config.glmApiBase);
    this.baseUrl = `${parsed.protocol}//${parsed.host}`;
  }

  /** 注册配额更新回调，用于注入到 AccountPool */
  onQuotaChange(cb: (hints: Map<number, number>) => void) {
    this.onQuotaUpdate = cb;
  }

  start() {
    this.run();
    this.timer = setInterval(() => this.run(), FETCH_INTERVAL_MS);
    console.log(`[Calibrator] 定时拉取上游用量已启动，${this.keys.length} 个 key，间隔 ${FETCH_INTERVAL_MS / 1000}s`);
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
        quotas: row.quotas ? JSON.parse(row.quotas) : null,
      });
    }
    return result;
  }

  private async run() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateStr = todayStart.toISOString().slice(0, 10);

    const results = await Promise.allSettled(
      this.keys.map((key, index) => this.fetchForKey(key, index, todayStart, now))
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

    // 收集各 key 的最高配额百分比，注入到 AccountPool
    const hints = new Map<number, number>();
    let successCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const d = r.value;
        upsert.run(dateStr, d.accountKeyIndex, d.upstreamTokens, d.upstreamCalls, d.quotas ? JSON.stringify(d.quotas) : null);
        successCount++;
        // 取该 key 所有配额限制中的最高百分比
        if (d.quotas?.limits.length) {
          const maxPct = Math.max(...d.quotas.limits.map(l => l.percentage));
          hints.set(d.accountKeyIndex, maxPct);
        }
      }
    }
    if (hints.size > 0 && this.onQuotaUpdate) {
      this.onQuotaUpdate(hints);
    }
    console.log(`[Calibrator] 上游数据已更新 | ${dateStr} | ${successCount}/${this.keys.length} 个 key 成功 | 配额: ${[...hints.entries()].map(([k, v]) => `#${k}=${v.toFixed(1)}%`).join(', ') || '无数据'}`);
  }

  private async fetchForKey(apiKey: string, index: number, start: Date, end: Date): Promise<KeyUpstreamData | null> {
    try {
      const [upstream, quotas] = await Promise.all([
        this.fetchModelUsage(apiKey, start, end),
        this.fetchQuotaLimit(apiKey),
      ]);
      if (!upstream) return null;
      return {
        accountKeyIndex: index,
        upstreamTokens: upstream.totalUsage.totalTokensUsage,
        upstreamCalls: upstream.totalUsage.totalModelCallCount,
        quotas,
      };
    } catch (err) {
      console.error(`[Calibrator] Key #${index} 拉取失败:`, err);
      return null;
    }
  }

  private async fetchModelUsage(apiKey: string, start: Date, end: Date): Promise<UpstreamModelUsage | null> {
    const fmt = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const url = `${this.baseUrl}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
    const res = await fetch(url, {
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(`[Calibrator] model-usage API 返回 ${res.status}`);
      return null;
    }
    const json = await res.json() as { success: boolean; data: UpstreamModelUsage };
    return json.success ? json.data : null;
  }

  private async fetchQuotaLimit(apiKey: string): Promise<QuotaLimit | null> {
    try {
      const url = `${this.baseUrl}/api/monitor/usage/quota/limit`;
      const res = await fetch(url, {
        headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      });
      if (!res.ok) return null;
      const json = await res.json() as { success: boolean; data: QuotaLimit };
      return json.success ? json.data : null;
    } catch {
      return null;
    }
  }
}
