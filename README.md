# ClaudeProxy

公司内部的 GLM API 代理服务，让团队成员通过统一的 API 端点使用 Claude Code，后台多账户自动负载均衡。

## 功能

- SSE 流式代理，完整转发 Anthropic API 格式请求到 GLM
- 多账户 round-robin 轮换，遇到 429 自动冷却并切换
- 按客户端 IP 记录用量（SQLite）
- 管理 API 查看账户状态和用量统计
- Docker 一键部署

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

# 服务端���
PORT=3000

# 管理 API 认证 token
ADMIN_TOKEN=your-admin-token
```

### 3. 启动

```bash
# 开发模式
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

## 管理 API

管理接口需要通过 `Authorization: Bearer <ADMIN_TOKEN>` 认证。

### 查看账户状态

```bash
curl http://localhost:3000/admin/accounts \
  -H "Authorization: Bearer your-admin-token"
```

返回每个账户的状态（active/cooldown）、累计请求数和 token 用量。

### 查看用量统计

```bash
# 按客户端 IP 汇总（默认最近 7 天）
curl http://localhost:3000/admin/usage?days=7 \
  -H "Authorization: Bearer your-admin-token"

# 总量汇总 + 每日明细
curl http://localhost:3000/admin/usage/summary?days=7 \
  -H "Authorization: Bearer your-admin-token"
```

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
| `DB_PATH` | SQLite 数据库路径 | `./data/proxy.db` |
