import BetterSqlite3 from 'better-sqlite3';
import { getDb } from './database.js';

export interface UsageRecord {
  clientIp: string;
  model: string;
  accountIndex: number;
  statusCode: number;
}

const FLUSH_INTERVAL_MS = 3000;

export class RequestLog {
  private insertStmt: BetterSqlite3.Statement;
  private buffer: UsageRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const db = getDb();
    this.insertStmt = db.prepare(`
      INSERT INTO requests (client_ip, model, account_key_index, status_code)
      VALUES (?, ?, ?, ?)
    `);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  record(r: UsageRecord) {
    this.buffer.push(r);
    // 如果 buffer 积累过多（如超过 500 条），立即触发 flush 防止内存膨胀
    if (this.buffer.length >= 500) {
      this.flush();
    }
  }

  /** 将 buffer 中的记录批量写入数据库 */
  flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const db = getDb();
      db.transaction(() => {
        for (const r of batch) {
          this.insertStmt.run(r.clientIp, r.model, r.accountIndex, r.statusCode);
        }
      })();
    } catch (err) {
      console.error('[Tracker] 批量写入失败，保留数据待下次重试:', err);
      // 将失败记录放回 buffer 尾部，避免丢失
      this.buffer.push(...batch);
    }
  }

  /** 停止定时器并刷盘剩余数据 */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Get usage grouped by client IP within last N days */
  getUsageByIp(days = 7) {
    const db = getDb();
    return db.prepare(`
      SELECT
        client_ip,
        COUNT(*) as total_requests,
        MIN(created_at) as first_request,
        MAX(created_at) as last_request
      FROM requests
      WHERE created_at >= datetime('now', '-' || ? || ' days', 'localtime')
      GROUP BY client_ip
      ORDER BY total_requests DESC
    `).all(days);
  }

  /** Get overall usage summary */
  getSummary(days = 7) {
    const db = getDb();
    return db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COUNT(DISTINCT client_ip) as unique_clients
      FROM requests
      WHERE created_at >= datetime('now', '-' || ? || ' days', 'localtime')
    `).get(days);
  }

  /** Get usage grouped by account (all-time) */
  getUsageByAccount() {
    const db = getDb();
    return db.prepare(`
      SELECT
        account_key_index as accountIndex,
        COUNT(*) as totalRequests
      FROM requests
      GROUP BY account_key_index
    `).all() as { accountIndex: number; totalRequests: number }[];
  }

  /** Get daily breakdown */
  getDailyBreakdown(days = 7) {
    const db = getDb();
    return db.prepare(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as total_requests
      FROM requests
      WHERE created_at >= datetime('now', '-' || ? || ' days', 'localtime')
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(days);
  }
}
