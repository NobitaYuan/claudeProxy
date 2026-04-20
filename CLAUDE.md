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
│   └── accountPool.ts # 账户池（round-robin、冷却、健康检查）
├── stats/
│   ├── db.ts          # SQLite 初始化
│   └── tracker.ts     # 用量记录和查询
└── admin/
    └── routes.ts      # 管理 API（账户状态、用量统计）
```

## 代码约定

- ESM 模块，import 路径必须带 `.js` 后缀
- 注释和 log 使用中文
- 环境变量统一在 `src/config.ts` 管理
- 
## 提交代码

不要在commit信息里写claudeCode水印！！！
不要在commit信息里写claudeCode水印！！！
不要在commit信息里写claudeCode水印！！！

## Code Quality

- **禁止补丁叠补丁式的修改** — 如果发现某处代码已经是 workaround 堆叠的状态，必须先重构到干净的状态再继续开发，不要在烂代码上继续打补丁
- **禁止在生产代码中使用 `any`** — 必须使用具体类型；第三方库类型缺失时可用 type assertion 并加注释说明原因
