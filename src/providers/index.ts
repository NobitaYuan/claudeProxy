import type { Provider } from './types.js';
import { GlmProvider } from './glm.js';

export type { Provider, QuotaDisplay, KeySyncResult } from './types.js';

export function createProvider(type: string, apiBase: string, apiKeys: string[]): Provider {
  switch (type) {
    case 'glm':
      return new GlmProvider(apiBase, apiKeys);
    default:
      throw new Error(`未知的 provider 类型: ${type}`);
  }
}
