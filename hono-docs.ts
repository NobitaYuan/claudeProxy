import { defineConfig } from '@rcmade/hono-docs';

export default defineConfig({
  tsConfigPath: './tsconfig.json',
  openApi: {
    openapi: '3.0.0',
    info: {
      title: 'ClaudeProxy Admin API',
      version: '1.0.0',
      description: 'Claude Code 代理服务管理 API — 账户池状态、用量统计、上游校准数据',
    },
    servers: [{ url: '/' }],
  },
  outputs: {
    openApiJson: './openapi/openapi.json',
  },
  apis: [
    {
      name: 'Admin API',
      apiPrefix: '/admin',
      appTypePath: 'src/admin/routes.ts',
      api: [
        {
          api: '/accounts',
          method: 'get',
          summary: '账户池状态',
          description:
            '返回所有账户的状态信息，包括上游 token 用量、调用次数和最新配额数据。',
          tag: ['Accounts'],
        },
        {
          api: '/usage',
          method: 'get',
          summary: '按客户端 IP 统计用量',
          description:
            '按客户端 IP 聚合返回请求用量。支持通过 `days` 查询参数指定时间范围（默认 7 天，最大 90 天）。',
          tag: ['Usage'],
        },
        {
          api: '/usage/summary',
          method: 'get',
          summary: '用量概览与每日明细',
          description:
            '返回整体用量统计摘要和每日请求数明细。支持通过 `days` 查询参数指定时间范围（默认 7 天，最大 90 天）。',
          tag: ['Usage'],
        },
        {
          api: '/calibration',
          method: 'get',
          summary: '上游校准数据',
          description:
            '返回所有 API Key 的最新校准快照，包括上游 token 计数、调用次数和配额百分比。',
          tag: ['Calibration'],
        },
      ],
    },
  ],
});
