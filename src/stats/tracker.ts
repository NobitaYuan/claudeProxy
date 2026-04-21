import BetterSqlite3 from 'better-sqlite3';
import { getDb } from './db.js';

export interface UsageRecord {
  clientIp: string;
  model: string;
  accountIndex: number;
  statusCode: number;
}

export class UsageTracker {
  private insertStmt: BetterSqlite3.Statement;

  constructor() {
    const db = getDb();
    this.insertStmt = db.prepare(`
      INSERT INTO requests (client_ip, model, account_key_index, status_code)
      VALUES (?, ?, ?, ?)
    `);
  }

  record(r: UsageRecord) {
    try {
      this.insertStmt.run(r.clientIp, r.model, r.accountIndex, r.statusCode);
    } catch (err) {
      console.error('[Tracker] Failed to record:', err);
    }
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
