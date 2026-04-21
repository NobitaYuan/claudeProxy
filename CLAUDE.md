# CLAUDE.md

> 运用第一性原理 思考，拒绝经验主义和路径盲从，不要假设我完全清楚目标，保持审慎，从原始需求和问题出发
> 若目标模糊请停下和我讨论，若目标清晰但路径非最优，请直接建议更短、更低成本的办法。

## 项目简介

GLM API 代理服务，为公司团队提供统一的 Claude Code API 入口，后台多账户负载均衡。

## 技术栈

- **框架**: Hono（Web 框架）+ @hono/node-server
- **语言**: TypeScript（ESM）
- **数据库**: better-sqlite3（嵌入式 SQLite）
- **运行时**: Node.js 20+

## 开发命令

```bash
pnpm dev      # 开发模式（tsx watch 热重载）
pnpm build    # 构建（tsup）
pnpm start    # 运行构建产物
```

## 项目结构

```
src/
├── index.ts           # 入口，启动服务，注入客户端 IP 中间件
├── config.ts          # 环境变量配置
├── proxy/
│   ├── handler.ts     # 流式代理核心（SSE 转发、429 重试、usage 提取）
│   └── accountPool.ts # 账户池（session 粘性绑定、最少绑定数分配、冷却）
├── stats/
│   ├── db.ts          # SQLite 初始化（requests + calibrations 表）
│   ├── tracker.ts     # 本地用量记录和查询（统一 token 计数）
│   └── calibrator.ts  # 定时拉取上游真实用量和配额（30 分钟一次）
└── admin/
    ├── routes.ts      # 管理 API（账户状态、用量统计、校准数据）
    ├── dashboard.ts   # 管理面板 HTML（主题切换、实时日志抽屉、ECharts 图表）
    └── events.ts      # SSE 事件总线（实时推送代理请求）
```

## 上游 GLM API 数据

代理通过每个 API Key 查询 GLM 平台的用量接口，认证方式为 `Authorization: {apiKey}`（不带 Bearer）。

### 用量查询

- **端点**: `GET {base}/api/monitor/usage/model-usage?startTime=...&endTime=...`
- **时间格式**: `YYYY-MM-DD HH:mm:ss`
- **返回**: `{ success, data: { totalUsage: { totalModelCallCount, totalTokensUsage } } }`

### 配额查询

- **端点**: `GET {base}/api/monitor/usage/quota/limit`
- **返回**: `{ success, data: { level, limits: [...] } }`
- **配额类型**:

| type | 含义 | 典型周期 |
|------|------|----------|
| `TIME_LIMIT` | Monthly MCP / Web Search / Reader / Zread 配额 | 月 |
| `TOKENS_LIMIT` (unit=3) | 5 小时 Token 配额 | 5h 滚动窗口 |
| `TOKENS_LIMIT` (unit=6) | 周度 Token 配额 | 周 |

- **limit 对象字段**: `type`, `percentage`(已用百分比), `currentValue?`, `usage?`, `nextResetTime`(Unix 时间戳)

## 负载均衡策略

当前采用 **session 粘性绑定**：
- Claude Code 在请求的 `metadata.user_id` 中传入 JSON：`{ device_id, account_uuid, session_id }`
- 同一 session_id 绑定到同一个 API Key（因为 prompt cache 按 key 绑定）
- 新 session 分配到当前绑定数最少的 active 账户
- 账户 429 时进入冷却期，已绑定该账户的 session 临时解绑重新分配

**已知约束**:
- GLM 的 Anthropic 兼容 prompt caching 按 API Key 隔离，切 key 后 cache 失效
- 目前 Calibrator 只用第一个 key 查询配额，多 key 场景下每个 key 的配额可能不同
- 后续可利用配额数据做更智能的调度（如避开即将耗尽配额的 key）

## Token 统计方式

- 本地统计：从 SSE 流中提取 `message_start.usage.input_tokens` + `message_delta.usage.output_tokens` 合并为单一 token 计数
- 上游数据：每 30 分钟拉取今日 00:00 至当前的 `totalTokensUsage` 和 `totalModelCallCount`
- 两者独立展示，不做校准/换算

## 数据库表结构

- **requests**: `id, client_ip, model, account_key_index, tokens, status_code, created_at`
- **calibrations**: `id, date, upstream_tokens, upstream_calls, quotas(JSON), created_at`

## Claude Code 请求格式

Claude Code 发送 Anthropic Messages API 请求，关键特征：
- 路径: `/v1/messages`
- `metadata.user_id` 是 JSON 字符串: `{"device_id":"...","account_uuid":"...","session_id":"..."}`
- 响应为 SSE 流，事件类型: `message_start`(含 input_tokens), `content_block_start/delta/stop`, `message_delta`(含 output_tokens), `message_stop`
- 类型从 `@anthropic-ai/sdk/resources/messages/messages.js` 导入

## 代码约定

- ESM 模块，import 路径必须带 `.js` 后缀
- 注释和 log 使用中文
- 环境变量统一在 `src/config.ts` 管理
## 提交代码

不要在commit信息里写claudeCode水印！！！
不要在commit信息里写claudeCode水印！！！
不要在commit信息里写claudeCode水印！！！

## Code Quality

- **禁止补丁叠补丁式的修改** — 如果发现某处代码已经是 workaround 堆叠的状态，必须先重构到干净的状态再继续开发，不要在烂代码上继续打补丁
- **禁止在生产代码中使用 `any`** — 必须使用具体类型；第三方库类型缺失时可用 type assertion 并加注释说明原因