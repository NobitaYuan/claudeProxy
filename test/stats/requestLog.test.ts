import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockRun = vi.fn();
const mockAll = vi.fn(() => []);
const mockGet = vi.fn(() => ({}));
const mockPrepare = vi.fn(() => ({ run: mockRun, all: mockAll, get: mockGet }));
const mockTransaction = vi.fn((fn: () => void) => () => fn());

vi.mock('../../src/stats/database.js', () => ({
  getDb: vi.fn(() => ({
    prepare: mockPrepare,
    transaction: mockTransaction,
  })),
}));

import { RequestLog } from '../../src/stats/requestLog.js';

describe('RequestLog', () => {
  let logs: RequestLog[] = [];

  function createLog() {
    const log = new RequestLog();
    logs.push(log);
    return log;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
    mockRun.mockClear();
    mockAll.mockClear();
    mockGet.mockClear();
    mockPrepare.mockClear();
    mockTransaction.mockClear();
    mockTransaction.mockImplementation((fn: () => void) => () => fn());
  });

  afterEach(() => {
    for (const log of logs) log.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('record 缓冲数据不立即写入', () => {
    const log = createLog();
    log.record({ clientIp: '1.1.1.1', model: 'claude', accountIndex: 0, statusCode: 200 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('buffer 达到 500 立即 flush', () => {
    const log = createLog();
    for (let i = 0; i < 500; i++) {
      log.record({ clientIp: '1.1.1.1', model: 'claude', accountIndex: 0, statusCode: 200 });
    }
    expect(mockRun).toHaveBeenCalledTimes(500);
  });

  it('定时器触发 flush', () => {
    const log = createLog();
    log.record({ clientIp: '1.1.1.1', model: 'claude', accountIndex: 0, statusCode: 200 });
    expect(mockRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('flush 失败保留数据并重试', () => {
    const log = createLog();
    mockTransaction.mockImplementationOnce(() => () => {
      throw new Error('db error');
    });
    log.record({ clientIp: '1.1.1.1', model: 'claude', accountIndex: 0, statusCode: 200 });
    vi.advanceTimersByTime(3000);
    // transaction 抛出，insertStmt.run 未执行
    expect(mockRun).not.toHaveBeenCalled();

    // 恢复正常 transaction 实现
    mockTransaction.mockImplementation((fn: () => void) => () => fn());
    vi.advanceTimersByTime(3000);
    // 重试成功
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('stop 清除定时器并 flush 剩余数据', () => {
    const log = createLog();
    log.record({ clientIp: '1.1.1.1', model: 'claude', accountIndex: 0, statusCode: 200 });
    log.stop();
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('getUsageByIp 调用正确的 SQL 和参数', () => {
    const log = createLog();
    log.getUsageByIp(7);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('client_ip'));
    expect(mockAll).toHaveBeenCalledWith(7);
  });

  it('getSummary 调用正确的 SQL 和参数', () => {
    const log = createLog();
    log.getSummary(7);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'));
    expect(mockGet).toHaveBeenCalledWith(7);
  });

  it('getUsageByAccount 调用正确的 SQL 和参数', () => {
    const log = createLog();
    log.getUsageByAccount();
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('account_key_index'));
    expect(mockAll).toHaveBeenCalled();
  });

  it('getDailyBreakdown 调用正确的 SQL 和参数', () => {
    const log = createLog();
    log.getDailyBreakdown(7);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DATE(created_at)'));
    expect(mockAll).toHaveBeenCalledWith(7);
  });
});
