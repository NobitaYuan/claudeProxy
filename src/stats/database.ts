import Database from 'better-sqlite3';
import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

let db: Database.Database;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时
const RETENTION_DAYS = 90;

function cleanupOldRequests() {
  if (!db) return;
  try {
    const result = db.prepare("DELETE FROM requests WHERE created_at < datetime('now', '-' || ? || ' days', 'localtime')").run(RETENTION_DAYS);
    if (result.changes > 0) {
      console.log(`[DB] 清理 ${result.changes} 条 ${RETENTION_DAYS} 天前的请求记录`);
    }
  } catch (err) {
    console.error('[DB] 清理旧记录失败:', err);
  }
}

export function initDb(): Database.Database {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  // requests 表有 tokens 列时重建（去掉本地 token 存储）
  const reqCols = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
  if (reqCols.length > 0 && reqCols.some(c => c.name === 'tokens')) {
    console.log('[DB] 重建 requests 表（移除 tokens 列）');
    db.exec(`
      CREATE TABLE requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_ip TEXT NOT NULL,
        model TEXT,
        account_key_index INTEGER,
        status_code INTEGER,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO requests_new (id, client_ip, model, account_key_index, status_code, created_at)
        SELECT id, client_ip, model, account_key_index, status_code, created_at FROM requests;
      DROP TABLE requests;
      ALTER TABLE requests_new RENAME TO requests;
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_requests_client_ip ON requests(client_ip)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at)');
  }

  // calibrations 表结构变更时重建
  const cols = db.prepare("PRAGMA table_info(calibrations)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some(c => c.name === 'account_key_index')) {
    console.log('[DB] 重建 calibrations 表（缺少 account_key_index）');
    db.exec('DROP TABLE IF EXISTS calibrations');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_ip TEXT NOT NULL,
      model TEXT,
      account_key_index INTEGER,
      status_code INTEGER,
      created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_requests_client_ip ON requests(client_ip);
    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_account ON requests(account_key_index);

    CREATE TABLE IF NOT EXISTS calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      account_key_index INTEGER NOT NULL,
      upstream_tokens INTEGER NOT NULL,
      upstream_calls INTEGER NOT NULL,
      quotas TEXT,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      UNIQUE(date, account_key_index)
    );
  `);

  // 启动定时清理任务
  cleanupOldRequests(); // 启动时先执行一次
  cleanupTimer = setInterval(cleanupOldRequests, CLEANUP_INTERVAL_MS);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDb(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}
