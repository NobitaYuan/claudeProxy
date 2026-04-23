/**
 * Provider 抽象层：定义上游 API 提供者需要实现的接口。
 * 不同厂商（GLM、Kimi 等）的 key/url 和配额接口数据结构不同，
 * 但代理转发本身都是 Anthropic 兼容格式，所以只抽象真正不同的部分。
 */

/** 通用的配额展示项 */
export interface QuotaDisplay {
  label: string;
  percentage: number;
  nextResetTime?: number;
}

/** 单个 key 的上游用量同步结果 */
export interface KeySyncResult {
  accountKeyIndex: number;
  upstreamTokens: number;
  upstreamCalls: number;
  quotas: QuotaDisplay[];
}

/** 上游 API 提供者接口 */
export interface Provider {
  readonly name: string;
  readonly apiBase: string;
  readonly apiKeys: string[];

  /** 构建转发给上游的 Authorization header 值 */
  buildAuthHeader(apiKey: string): string;

  /** 拉取指定 key 的上游用量和配额数据 */
  fetchKeyUsage(apiKey: string, index: number, start: Date, end: Date): Promise<KeySyncResult | null>;

  /** 从配额数据中提取用于负载均衡调度的主配额百分比 */
  extractPrimaryQuota(quotas: QuotaDisplay[]): number | undefined;
}
