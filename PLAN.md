# Claude Code GLM API 代理服务

## Context

公司团队（<20人）订阅了 GLM Coding Plan，需要一个内网代理服务，让所有员工通过统一的 API 端点使用 Claude Code。代理后台管理多个 GLM 账户（2-3个），做负载轮换和用量统计。

**核心价值：** 员工只需配置一个 API Base URL 即可使用，无需任何 token 认证，无需每人持有独立 GLM 账户。

**关键技术约束：**
- GLM Coding Plan API 兼容 Anthropic API 格式（/v1/messages），可直接转发
- Claude Code 使用 SSE 流式调用，代理必须支持流式转发
- 部署在公司内网服务器
- 员工无需认证，配 URL 即用

---

## 技术选型

| 层面 | 选择 | 理由 |
|------|------|------|
| 框架 | **Hono** | 轻量、高性能、原生支持流式响应 |
| 语言 | **TypeScript** | 类型安全 |
| 数据库 | **better-sqlite3** | 零依赖嵌入式，小团队够用 |
| 部署 | **Docker** | 内网一键部署 |

---

## 项目结构

```
d:/coding/claudeProxy/
├── src/
│   ├── index.ts              # 入口，启动服务
│   ├── config.ts             # 配置管理（账户池等）
│   ├── proxy/
│   │   ├── handler.ts        # 主代理逻辑：接收请求、转发、流式回传
│   │   └── accountPool.ts    # 账户池管理：轮换、冷却、健康检查
│   ├── stats/
│   │   ├── db.ts             # SQLite 初始化 & 操作
│   │   └── tracker.ts        # 用量记录（按 IP + token 数）
│   └── admin/
│       └── routes.ts          # 管理 API（查看用量、账户状态，需 admin token）
├── data/                     # SQLite 数据文件（gitignore）
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env.example              # 环境变量模板
```

---

## 实现计划

### Step 1: 项目初始化

- 在 `d:/coding/claudeProxy` 创建项目
- 初始化 package.json、tsconfig.json
- 安装依赖：hono、@hono/node-server、better-sqlite3、dotenv
- 构建工具：tsx（开发）+ tsup（打包）

### Step 2: 配置管理 (`config.ts`)

环境变量驱动，从 `.env` 文件读取：
```
# GLM 账户池（逗号分隔多个 key）
GLM_API_KEYS=sk-xxx,sk-yyy,sk-zzz
GLM_API_BASE=https://open.bigmodel.cn/api/paas

# 服务配置
PORT=3000

# 管理 API 的认证（仅管理员接口用）
ADMIN_TOKEN=admin-secret-token
```

员工侧无需任何 token，Claude Code 配置 `ANTHROPIC_API_KEY` 时随便填一个占位符即可。

### Step 3: 账户池管理 (`accountPool.ts`)

核心逻辑：
- **Round-robin 轮换**：维护一个索引，每次请求递增取下一个账户
- **冷却机制**：遇到 429 时，将该账户标记为冷却状态（默认 60s），自动跳过
- **健康恢复**：冷却时间到期后自动恢复可用
- **全部冷却降级**：所有账户都冷却时，返回 503 并提示稍后重试

### Step 4: 流式代理 (`handler.ts`) — 核心

关键实现：
1. 接收 Claude Code 的请求（Anthropic API 格式）
2. 从账户池取一个可用 key
3. 将请求原样转发到 GLM API，替换 Authorization header
4. **流式转发响应**：用 `fetch` + `ReadableStream` pipe 回客户端
5. 解析 SSE 事件流，提取 usage 数据（input/output tokens）
6. 将 usage 数据传给 tracker 记录（按请求 IP 标识来源）
7. 如果上游返回 429，触发账户冷却，用下一个账户重试

路由匹配：
- `POST /v1/messages` — 主要代理入口
- `GET /v1/messages/:id` — 可能的消息查询（透传）

### Step 5: 用量统计 (`stats/`)

SQLite 表结构：
```sql
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ip TEXT NOT NULL,
  model TEXT,
  account_key_index INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  status_code INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Step 6: 管理 API (`admin/routes.ts`)

需要 `ADMIN_TOKEN` 认证（通过 `Authorization: Bearer xxx` header）：
- `GET /admin/accounts` — 查看账户池状态（哪个在用、哪个冷却中、累计用量）
- `GET /admin/usage?ip=xxx&days=7` — 按 IP 查看用量统计
- `GET /admin/usage/summary` — 总用量汇总

### Step 7: Docker 部署

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## Claude Code 客户端配置

员工使用时只需配置环境变量：

```bash
# 指向内网代理
ANTHROPIC_BASE_URL=http://内网IP:3000
# 随便填一个占位符，代理不校验
ANTHROPIC_API_KEY=placeholder
```

---

## 验证方案

1. **启动服务** — `pnpm dev`，确认服务监听 3000 端口
2. **流式代理测试** — 用 curl 发一个 Anthropic API 格式的 SSE 请求，确认流式响应正常
3. **账户轮换测试** — 模拟 429 响应，确认自动切换到下一个账户
4. **用量统计测试** — 发几次请求后，调用 admin API 确认数据记录正确
5. **Claude Code 端到端测试** — 配置 `ANTHROPIC_BASE_URL`，实际运行 Claude Code 验证完整链路
