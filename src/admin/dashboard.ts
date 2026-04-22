import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveHtmlPath(): string {
  const candidates = [
    resolve(process.cwd(), 'public/dashboard.html'),      // 开发: pnpm dev
    resolve(__dirname, '../../public/dashboard.html'),      // 开发: tsx watch
    resolve(__dirname, 'public/dashboard.html'),            // 生产: node dist/index.js
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('public/dashboard.html not found');
}

export const DASHBOARD_HTML = readFileSync(resolveHtmlPath(), 'utf-8');
