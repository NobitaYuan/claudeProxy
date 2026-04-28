import { Hono } from 'hono';
import { Scalar } from '@scalar/hono-api-reference';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const docs = new Hono()
  .get(
    '/',
    Scalar({
      url: '/admin/docs/openapi.json',
      theme: 'kepler',
      layout: 'modern',
    })
  )
  .get('/openapi.json', (c) => {
    const raw = readFileSync(
      resolve(process.cwd(), './openapi/openapi.json'),
      'utf-8'
    );
    const spec = JSON.parse(raw);
    spec.components = {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '输入你的管理员Token',
        },
      },
    };
    spec.security = [{ bearerAuth: [] }];
    return c.json(spec);
  });

export default docs;
