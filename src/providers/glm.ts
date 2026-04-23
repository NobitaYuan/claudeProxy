import type { Provider, QuotaDisplay, KeySyncResult } from './types.js';

const FETCH_TIMEOUT_MS = 30 * 1000; // 30 秒

// === GLM 特有的响应类型，仅在此文件内使用 ===

interface UpstreamModelUsage {
  totalUsage: {
    totalModelCallCount: number;
    totalTokensUsage: number;
  };
}

interface QuotaLimit {
  limits: {
    type: string;
    percentage: number;
    unit?: number;
    currentValue?: number;
    usage?: number;
    usageDetails?: { modelCode: string; usage: number }[];
    nextResetTime: number;
  }[];
  level: string;
}

export class GlmProvider implements Provider {
  readonly name = 'glm';
  readonly apiBase: string;
  readonly apiKeys: string[];
  private readonly baseUrl: string;

  constructor(apiBase: string, apiKeys: string[]) {
    this.apiBase = apiBase;
    this.apiKeys = apiKeys;
    const parsed = new URL(apiBase);
    this.baseUrl = `${parsed.protocol}//${parsed.host}`;
  }

  buildAuthHeader(apiKey: string): string {
    // GLM 认证不带 Bearer 前缀
    return apiKey;
  }

  async fetchKeyUsage(apiKey: string, index: number, start: Date, end: Date): Promise<KeySyncResult | null> {
    try {
      const [upstream, quotaData] = await Promise.all([
        this.fetchModelUsage(apiKey, start, end),
        this.fetchQuotaLimit(apiKey),
      ]);
      if (!upstream) return null;
      return {
        accountKeyIndex: index,
        upstreamTokens: upstream.totalUsage.totalTokensUsage,
        upstreamCalls: upstream.totalUsage.totalModelCallCount,
        quotas: quotaData ? this.toQuotaDisplays(quotaData) : [],
      };
    } catch (err) {
      console.error(`[GlmProvider] Key #${index} 拉取失败:`, err);
      return null;
    }
  }

  extractPrimaryQuota(quotas: QuotaDisplay[]): number | undefined {
    if (quotas.length === 0) return undefined;
    // 优先使用 5 小时配额
    const fiveHour = quotas.find(q => q.label === '5小时 Token');
    return fiveHour ? fiveHour.percentage : Math.max(...quotas.map(q => q.percentage));
  }

  /** 将 GLM 的 QuotaLimit 转换为通用的 QuotaDisplay[] */
  private toQuotaDisplays(quotaData: QuotaLimit): QuotaDisplay[] {
    const displays: QuotaDisplay[] = [];
    for (const l of quotaData.limits) {
      if (l.type === 'TIME_LIMIT') {
        displays.push({ label: '月度 MCP', percentage: l.percentage, nextResetTime: l.nextResetTime });
      } else if (l.type === 'TOKENS_LIMIT') {
        if (l.unit === 3) {
          displays.push({ label: '5小时 Token', percentage: l.percentage, nextResetTime: l.nextResetTime });
        } else if (l.unit === 6) {
          displays.push({ label: '周度 Token', percentage: l.percentage, nextResetTime: l.nextResetTime });
        }
      }
    }
    return displays;
  }

  private async fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      return res;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.error(`[GlmProvider] 请求超时: ${url}`);
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchModelUsage(apiKey: string, start: Date, end: Date): Promise<UpstreamModelUsage | null> {
    const fmt = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const url = `${this.baseUrl}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(start))}&endTime=${encodeURIComponent(fmt(end))}`;
    const res = await this.fetchWithTimeout(url, { 'Authorization': apiKey, 'Content-Type': 'application/json' });
    if (!res) return null;
    if (!res.ok) {
      console.error(`[GlmProvider] model-usage API 返回 ${res.status}`);
      return null;
    }
    const json = await res.json() as { success: boolean; data: UpstreamModelUsage };
    return json.success ? json.data : null;
  }

  private async fetchQuotaLimit(apiKey: string): Promise<QuotaLimit | null> {
    const url = `${this.baseUrl}/api/monitor/usage/quota/limit`;
    const res = await this.fetchWithTimeout(url, { 'Authorization': apiKey, 'Content-Type': 'application/json' });
    if (!res) return null;
    if (!res.ok) return null;
    const json = await res.json() as { success: boolean; data: QuotaLimit };
    return json.success ? json.data : null;
  }
}
