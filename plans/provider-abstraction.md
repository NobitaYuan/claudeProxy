# Provider 抽象层：解除数据库/同步层与 GLM 的耦合

## Context

当前项目的 upstreamSync、admin routes、dashboard 都硬编码了 GLM 特有的配额类型（TIME_LIMIT、TOKENS_LIMIT unit 3/6）、API 端点和响应结构。用户同时使用 GLM 和 Kimi 的 coding plan，两者的区别是：key/url 不同 + 配额/用量接口数据结构不同。需要把 GLM 特定逻辑抽到 Provider 接口后面，让系统可以适配不同厂商。

## 改造范围

**核心思路**：只抽象真正不同的部分——认证方式、上游数据拉取、配额解析。代理转发、session 绑定、负载均衡等逻辑已经是通用的，不动。

### 1. 新建 `src/providers/types.ts` — Provider 接口定义

```typescript
// 通用的配额展示项（替换 GLM 的 QuotaLimit）
export interface QuotaDisplay {
  label: string;          // "5小时 Token" / "月度配额" 等
  percentage: number;     // 0-100
  nextResetTime?: number; // Unix 时间戳，可选
}

// Provider 接口
export interface Provider {
  readonly name: string;           // "glm" / "kimi"
  readonly apiBase: string;        // 代理转发用的上游 base URL
  readonly apiKeys: string[];

  // 构建转发给上游的 Authorization header 值
  buildAuthHeader(apiKey: string): string;

  // 拉取指定 key 的上游用量和配额，返回 null 表示失败
  fetchKeyUsage(apiKey: string, index: number, start: Date, end: Date): Promise<KeySyncResult | null>;

  // 从 QuotaDisplay[] 中提取用于负载均衡的主配额百分比
  extractPrimaryQuota(quotas: QuotaDisplay[]): number | undefined;
}

export interface KeySyncResult {
  accountKeyIndex: number;
  upstreamTokens: number;
  upstreamCalls: number;
  quotas: QuotaDisplay[];
}
```

### 2. 新建 `src/providers/glm.ts` — GLM 实现

把 `upstreamSync.ts` 中所有 GLM 特定代码搬过来：
- `fetchModelUsage` → `fetchKeyUsage` 内部调用
- `fetchQuotaLimit` → 同上
- GLM 的 `QuotaLimit` 类型、响应解析逻辑 → 类内部私有
- 将 GLM 的 `QuotaLimit.limits` 转换为 `QuotaDisplay[]`
- `extractPrimaryQuota`：返回 5h token 配额百分比，回退到最大值
- `buildAuthHeader`：返回 `apiKey`（GLM 不带 Bearer）
- `fetchWithTimeout` 辅助方法一并搬入

### 3. 新建 `src/providers/kimi.ts` — Kimi 实现（骨架）

- `buildAuthHeader`：按 Kimi 的认证方式
- `fetchKeyUsage`：按 Kimi 的用量/配额接口实现（待确认具体接口）
- `extractPrimaryQuota`：按 Kimi 的配额结构选择主配额

### 4. 新建 `src/providers/index.ts` — 工厂 + re-export

```typescript
export function createProvider(type: string, apiBase: string, apiKeys: string[]): Provider {
  switch (type) {
    case 'glm': return new GlmProvider(apiBase, apiKeys);
    case 'kimi': return new KimiProvider(apiBase, apiKeys);
    default: throw new Error(`Unknown provider: ${type}`);
  }
}
```

### 5. 修改 `src/config.ts` — 通用化配置

```typescript
providerType: process.env.PROVIDER_TYPE || 'glm',
apiBase: process.env.API_BASE || process.env.GLM_API_BASE || 'https://open.bigmodel.cn/api/anthropic',
apiKeys: (process.env.API_KEYS || process.env.GLM_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
// 保留旧字段别名，渐进迁移
get glmApiBase() { return this.apiBase; },
get glmApiKeys() { return this.apiKeys; },
```

### 6. 修改 `src/stats/upstreamSync.ts` — 解耦 GLM

- 构造函数接收 `Provider` 实例：`constructor(provider: Provider)`
- 删除所有 GLM 特定方法：`fetchModelUsage`、`fetchQuotaLimit`、`fetchForKey`
- 删除 GLM 类型：`UpstreamModelUsage`、`QuotaLimit`
- `KeyUpstreamData.quotas` 类型改为 `QuotaDisplay[]`
- `run()` 调用 `provider.fetchKeyUsage()` 和 `provider.extractPrimaryQuota()`
- `fetchWithTimeout` 保留为类内通用方法或提取到 utils

### 7. 修改 `src/admin/routes.ts` — 通用化配额展示

- 删除 `extractQuotaPercentages()` 函数（GLM 的 TIME_LIMIT/TOKENS_LIMIT/unit 3/6 逻辑）
- `/accounts` 端点直接透传 `QuotaDisplay[]`：
  ```typescript
  // 之前：quotas: { fiveHour: 50, weekly: 30, monthly: 20 }
  // 之后：quotas: [{ label: "5小时 Token", percentage: 50 }, ...]
  quotas: calData?.quotas ?? [],
  ```

### 8. 修改 `public/dashboard.html` — 动态渲染配额

```javascript
// 之前（硬编码三类配额）：
const q = a.quotas || {};
buildQuotaBars([
  { label: '5小时 Token', pct: q.fiveHour },
  { label: '周度 Token', pct: q.weekly },
  { label: '月度 MCP', pct: q.monthly },
]);

// 之后（动态迭代）：
buildQuotaBars((a.quotas || []).map(q => ({ label: q.label, pct: q.percentage })));
```

`buildQuotaBars` 函数本身不需要改，它已经接受 `{ label, pct }[]` 数组。

### 9. 修改 `src/proxy/proxy.ts` — 从 Provider 获取连接信息

- `createProxyHandler` 新增 `provider: Provider` 参数
- 用 `provider.apiBase` 替换 `config.glmApiBase`
- 用 `provider.buildAuthHeader(account.apiKey)` 替换硬编码的 `Bearer ${account.apiKey}`

### 10. 修改 `src/index.ts` — 组装 Provider

```typescript
import { createProvider } from './providers/index.js';
const provider = createProvider(config.providerType, config.apiBase, config.apiKeys);
const upstreamSync = new UpstreamSync(provider);
// ... proxyHandler 传入 provider
```

### 11. 修改 `src/proxy/accountBalancer.ts` — 错误信息通用化

- 错误消息 `'GLM_API_KEYS is empty'` → `'No API keys configured'`
- 构造函数从 `config.glmApiKeys` 改为接收 Provider 或直接用 `config.apiKeys`

## 不需要改的文件

- `src/stats/database.ts` — schema 已经通用
- `src/stats/requestLog.ts` — 已经通用
- `src/admin/dashboard.ts` — 只是 HTML 模板字符串，改动在 `dashboard.html`
- `src/admin/events.ts` — 已经通用

## 测试更新

- `test/stats/upstreamSync.test.ts`：改为 mock Provider 接口而非 mock global fetch + GLM 响应格式
- `test/admin/routes.test.ts`：mock 数据中 quotas 字段从 `{ level, limits }` 改为 `QuotaDisplay[]` 格式；断言 `quotas.fiveHour` 改为 `quotas[0].percentage`
- `test/proxy/accountBalancer.test.ts`：错误消息字符串更新

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/providers/types.ts` | 新建 |
| `src/providers/glm.ts` | 新建 |
| `src/providers/kimi.ts` | 新建（骨架） |
| `src/providers/index.ts` | 新建 |
| `src/config.ts` | 修改 |
| `src/stats/upstreamSync.ts` | 修改（大幅精简） |
| `src/admin/routes.ts` | 修改（删 extractQuotaPercentages） |
| `src/proxy/proxy.ts` | 修改（接入 Provider） |
| `src/proxy/accountBalancer.ts` | 微调 |
| `src/index.ts` | 修改 |
| `public/dashboard.html` | 修改（动态配额渲染） |
| `test/stats/upstreamSync.test.ts` | 修改 |
| `test/admin/routes.test.ts` | 修改 |

## 实施顺序

1. `src/providers/types.ts` → `src/providers/glm.ts` → `src/providers/index.ts`（新代码，不影响现有）
2. `src/config.ts`（加通用字段 + 保留别名）
3. `src/stats/upstreamSync.ts`（接入 Provider，删除 GLM 代码）
4. `src/proxy/proxy.ts` + `src/proxy/accountBalancer.ts` + `src/index.ts`（组装）
5. `src/admin/routes.ts` + `public/dashboard.html`（配额展示通用化）
6. 测试文件更新
7. `src/providers/kimi.ts`（Kimi 骨架，等接口确认后补全）

## 验证方式

1. `pnpm build` 编译通过
2. `pnpm test` 所有测试通过
3. 不设置新环境变量时，行为与改造前完全一致（GLM 为默认 provider）
4. 设置 `PROVIDER_TYPE=kimi` + `API_BASE=...` + `API_KEYS=...` 后能启动（Kimi 骨架报错是预期的）
