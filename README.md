# ClaudeProxy

公司内部的 GLM API 代理服务，让团队成员通过统一的 API 端点使用 Claude Code，后台多账户自动负载均衡，自带 Web 管理面板。

## 架构

```
                     员工 (Claude Code)
                           │
                   1. POST /v1/messages
                           │
                           ▼
+-----------------------------------------------------------------+     +-----------+
|                       代理服务 (Hono)                            |     |  SQLite   |
|                                                                 |◄───►|  数据库    |
|   +-----------+     +---------------+      +----------------+   |     +-----------+
|   |  请求记录  | ──► |    调度算法    |  ◄── |  上游用量记录   |   |
|   |RequestLog |     |AccountBalancer|      |   UpstreamSync |   |
|   +-----------+     +---------------+      +----------------+   |
|                         │                                       |
|                         ▼                                       |
+-----------------------------------------------------------------+
                          │
                  2. 分配 Key 转发请求
                          │
                          ▼
                 +-----------------+
                 |  GLM 上游 API   |
                 +--------+--------+
                          │
                          ▼
                3. SSE 流式响应原路返回

```

## 账号切换算法

代理的核心是**三层调度策略**，在保证 prompt cache 命中率的同时避免配额耗尽。

### 1. Session 粘性绑定

Claude Code 的每个请求在 `metadata.user_id` 中携带 `session_id`：

```json
{ "device_id": "xxx", "account_uuid": "xxx", "session_id": "session_abc123" }
```

同一 `session_id` **始终路由到同一个 API Key**。原因是 GLM 的 Anthropic 兼容 prompt cache 按 Key 隔离，切换 Key 会导致 cache 全部失效。

绑定关系在内存 Map 中维护，每次请求刷新 `lastActivity` 时间戳。

**Session 过期清理**：每 5 分钟扫描一次，超过 30 分钟（`SESSION_TIMEOUT_MS` 可配）没有请求的 session 绑定自动清除，确保 `sessionCount` 反映真实活跃数，负载均衡决策不会失真。

### 2. 最少绑定数分配

新 session 需要分配账户时，选择当前绑定 session 数最少的 active 账户：

```
Account #0: 5 sessions (active)  ← 跳过
Account #1: 3 sessions (active)  ← 选中
Account #2: cooldown
Account #3: 3 sessions (active)  ← 同绑定数，看配额
```

### 3. 配额感知调度

UpstreamSync 每 30 分钟拉取每个 Key 的三类配额百分比，写入 DB。AccountBalancer 调度时通过 `getQuotaHints()` 从 DB 读取各 key 的 5 小时配额百分比。

| 配额类型 | 周期 | 说明 |
|---------|------|------|
| 5h Token | 5 小时滚动窗口 | `TOKENS_LIMIT` (unit=3) |
| 周度 Token | 周 | `TOKENS_LIMIT` (unit=6) |
| 月度 MCP | 月 | `TIME_LIMIT` |

分配时：
- 配额差距 >5% → 选配额占用更**低**的 Key（避免某个 Key 先耗尽）
- 配额差距 ≤5% → 选绑定 session 数更少的 Key（均衡负载）

### 4. 429 冷却与重试

```
请求到达
  │
  ▼
从 AccountBalancer 按 session 粘性获取账户
  │
  ▼
向上游发起请求
  │
  ├── 成功 → SSE 流式转发给客户端
  │
  ├── 429 限流 → 冷却该账户（默认 60s，或用 retry-after）
  │              解绑当前 session
  │              选下一个账户重试（最多 3 次）
  │
  └── 网络异常 → 重试（最多 3 次）

所有账户都在冷却 → 返回 503
重试用尽仍失败 → 返回 502
```

冷却期到期后账户自动恢复为 active，已解绑的 session 下次请求时重新分配。

## 管理面板

访问 `http://<代理IP>:3000/admin/dashboard`，输入 `ADMIN_TOKEN` 登录。

### 功能

| 功能 | 说明 |
|------|------|
| **Per-Key 状态卡片** | 每个 Key 的活跃 session 数、今日上游 token 用量、三类配额进度条 |
| **配额进度条** | 绿色 (<70%) → 橙色 (70-90%) → 红色 (>90%)，实时反映调度决策 |
| **每日趋势图** | Chart.js 折线图，最近 7 天请求数 |
| **客户端用量表** | 按 IP 统计请求数和最后请求时间 |
| **实时请求日志** | 右侧抽屉，SSE 推送，保留最近 30 条 |
| **主题切换** | 深色 / 浅色 |
| **自动刷新** | 15s / 30s / 60s / 手动 |

### 管理 API

所有接口需要 `Authorization: Bearer <ADMIN_TOKEN>` 认证。

#### 账户状态

```bash
curl http://localhost:3000/admin/accounts \
  -H "Authorization: Bearer your-token"
```

返回每个账户的状态、活跃 session 数、今日上游 token、三类配额百分比。

#### 用量统计

```bash
# 按客户端 IP 汇总
curl http://localhost:3000/admin/usage?days=7 \
  -H "Authorization: Bearer your-token"

# 总量汇总 + 每日明细
curl http://localhost:3000/admin/usage/summary?days=7 \
  -H "Authorization: Bearer your-token"
```

#### 上游校准数据

```bash
curl http://localhost:3000/admin/calibration \
  -H "Authorization: Bearer your-token"
```

返回每个 Key 最近一次从 GLM 平台拉取的真实用量和配额快照。

#### 实时日志流 (SSE)

```bash
curl http://localhost:3000/admin/events?token=your-token
```

每个代理请求实时推送 JSON 事件（包含 IP、模型、账户、session ID）。

## 上游配额同步

UpstreamSync 在后台每 30 分钟执行一次：

1. **并发拉取**每个 Key 的上游数据（用量 + 配额）
2. **用量接口**：`GET {base}/api/monitor/usage/model-usage?startTime=...&endTime=...`
   - 获取今日 `totalTokensUsage` 和 `totalModelCallCount`
3. **配额接口**：`GET {base}/api/monitor/usage/quota/limit`
   - 获取三类配额的 `percentage`（已用百分比）
4. 写入 `calibrations` 表（按日期 + Key 去重，同天多次拉取覆盖更新）
5. AccountBalancer 调度时通过 `getQuotaHints()` 从 DB 读取各 key 的 5 小时配额百分比

```
UpstreamSync.run() ──► fetchForKey(key#0) ──► model-usage + quota-limit
                   ──► fetchForKey(key#1) ──► model-usage + quota-limit
                   ──► ...
                              │
                              ▼
                    写入 calibrations 表
                              │
                    AccountBalancer.leastLoadedAccount()
                    ──► upstreamSync.getQuotaHints() 从 DB 读取
```

## 快速开始

### 1. 安装

```bash
pnpm install
```

### 2. 配置

复制 `.env.example` 为 `.env`，填入实际配置：

```bash
cp .env.example .env
```

```env
# GLM 账户池（逗号分隔多个 key）
GLM_API_KEYS=sk-你的key1,sk-你的key2

# GLM API 端点
GLM_API_BASE=https://open.bigmodel.cn/api/anthropic

# 服务端口
PORT=3000

# 管理 API 认证 token
ADMIN_TOKEN=your-admin-token

# 429 冷却时间（毫秒）
COOLDOWN_MS=60000

# 数据库路径
DB_PATH=./data/proxy.db
```

### 3. 启动

```bash
# 开发模式（热重载）
pnpm dev

# 生产模式
pnpm build && pnpm start
```

启动后会显示：

```
=== ClaudeProxy Started ===
  Port:     3000
  Accounts: 2
  Upstream: https://open.bigmodel.cn/api/anthropic
  IPs:      192.168.1.100

Dashboard:
  http://192.168.1.100:3000/admin/dashboard

Claude Code config for employees:
  ANTHROPIC_BASE_URL=http://192.168.1.100:3000
  ANTHROPIC_API_KEY=placeholder
```

## 员工使用

在 Claude Code 中配置环境变量即可：

```bash
ANTHROPIC_BASE_URL=http://代理服务器IP:3000
ANTHROPIC_API_KEY=placeholder
```

无需个人 API Key，配好 URL 直接使用。

## Docker 部署

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f
```

数据持久化在 `./data/` 目录，通过 volume 映射。

## 配置项

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GLM_API_KEYS` | GLM API Key 列表（逗号分隔） | 无（必填） |
| `GLM_API_BASE` | GLM API 端点 | `https://open.bigmodel.cn/api/anthropic` |
| `PORT` | 服务端口 | `3000` |
| `ADMIN_TOKEN` | 管理 API 认证 token | `admin-secret-token` |
| `COOLDOWN_MS` | 429 后账户冷却时间（毫秒） | `60000` |
| `SESSION_TIMEOUT_MS` | Session 绑定过期时间（毫秒），超时自动清理 | `1800000`（30 分钟） |
| `DB_PATH` | SQLite 数据库路径 | `./data/proxy.db` |

## 技术栈

- **框架**: Hono + @hono/node-server
- **语言**: TypeScript (ESM)
- **数据库**: better-sqlite3（嵌入式 SQLite）
- **运行时**: Node.js 20+
