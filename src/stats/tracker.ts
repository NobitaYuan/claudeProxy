import BetterSqlite3 from 'better-sqlite3';
import { getDb } from './db.js';

export interface UsageRecord {
  clientIp: string;
  model: string;
  accountIndex: number;
  inputTokens: number;
  outputTokens: number;
  statusCode: number;
}

export class UsageTracker {
  private insertStmt: BetterSqlite3.Statement;

  constructor() {
    const db = getDb();
    this.insertStmt = db.prepare(`
      INSERT INTO requests (client_ip, model, account_key_index, input_tokens, output_tokens, status_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  record(r: UsageRecord) {
    try {
      this.insertStmt.run(r.clientIp, r.model, r.accountIndex, r.inputTokens, r.outputTokens, r.statusCode);
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
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
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
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        COUNT(DISTINCT client_ip) as unique_clients
      FROM requests
      WHERE created_at >= datetime('now', '-' || ? || ' days', 'localtime')
    `).get(days);
  }

  /** Get daily breakdown */
  getDailyBreakdown(days = 7) {
    const db = getDb();
    return db.prepare(`
      SELECT
        DATE(created_at, 'localtime') as date,
        COUNT(*) as total_requests,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens
      FROM requests
      WHERE created_at >= datetime('now', '-' || ? || ' days', 'localtime')
      GROUP BY DATE(created_at, 'localtime')
      ORDER BY date DESC
    `).all(days);
  }
}
