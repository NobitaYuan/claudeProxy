import { EventEmitter } from 'node:events';
import type { Context } from 'hono';
import { config } from '../config.js';

export interface ProxyEvent {
  accountIndex: number;
  clientIp: string;
  model: string;
  sessionId: string;
  type: 'bind' | 'request';
  statusCode: number;
  contentTypes: string[];
}

class DashboardEventBus {
  private emitter = new EventEmitter();
  private clients: Set<{ write: (data: string) => void }> = new Set();

  /** 广播事件给所有 SSE 客户端 */
  emitProxyEvent(event: ProxyEvent) {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** SSE 端点 handler */
  handler(c: Context) {
    const token = c.req.query('token');
    if (!token || token !== config.adminToken) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const stream = new ReadableStream({
      start: (controller) => {
        const writer = {
          write: (data: string) => {
            controller.enqueue(new TextEncoder().encode(data));
          },
        };
        this.clients.add(writer);

        // 心跳，防止连接超时
        const heartbeat = setInterval(() => {
          try { writer.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
        }, 15000);

        // 客户端断开时清理
        return () => {
          clearInterval(heartbeat);
          this.clients.delete(writer);
        };
      },
      cancel: () => {},
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }
}

export const eventBus = new DashboardEventBus();
