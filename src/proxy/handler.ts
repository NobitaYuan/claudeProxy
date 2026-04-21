import type { Context } from 'hono';
import type { AccountPool, Account } from './accountPool.js';
import { config } from '../config.js';
import type { UsageTracker } from '../stats/tracker.js';
import { eventBus } from '../admin/events.js';
import type {
  MessageCreateParams,
  MessageParam,
  ContentBlockParam,
  TextBlockParam,
  RawMessageStreamEvent,
  Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

type Env = { Variables: { clientIp: string } };

// 429（限流）时最多重试的账户切换次数
const MAX_RETRIES = 3;

// 将请求中的完整对话结构格式化为可读的日志摘要
function formatConversationPreview(body: MessageCreateParams): string {
  try {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return '(empty)';

    const systemHint = body.system
      ? (typeof body.system === 'string'
        ? `system: ${truncate(body.system, 40)}\n`
        : `system: ${(body.system as ContentBlockParam[]).filter(b => b.type === 'text').map(b => truncate((b as TextBlockParam).text, 40)).join('; ')}\n`)
      : '';

    const parts = messages.map((msg, i) => {
      const tag = msg.role === 'user' ? 'user' : 'assistant';
      const blocks = typeof msg.content === 'string'
        ? [{ type: 'text' as const, text: msg.content }]
        : (msg.content as ContentBlockParam[]);

      const items = blocks.map(b => {
        switch (b.type) {
          case 'text':
            return truncate(b.text, 80);
          case 'tool_use':
            return `[tool_use: ${b.name}]`;
          case 'tool_result':
            return typeof b.content === 'string'
              ? `[tool_result${b.is_error ? '!' : ''}: ${truncate(b.content, 40)}]`
              : `[tool_result${b.is_error ? '!' : ''}]`;
          case 'thinking':
            return `[thinking: ${truncate(b.thinking, 40)}]`;
          default:
            return `[${b.type}]`;
        }
      });

      const isNewTurn = i > 0 && msg.role === 'user' && messages[i - 1].role === 'assistant';
      return `${isNewTurn ? '---\n' : ''}${tag}: ${items.join(' | ')}`;
    });

    return systemHint + parts.join('\n');
  } catch {
    return '(parse error)';
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '...' : flat;
}

// 从 metadata.user_id 中提取 session_id（Claude Code 传入的是 JSON 字符串）
function extractSessionId(body: MessageCreateParams): string {
  try {
    const raw = body.metadata as Record<string, string> | undefined;
    if (!raw?.user_id) return 'unknown';
    const parsed = JSON.parse(raw.user_id) as { session_id?: string };
    return parsed.session_id || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createProxyHandler(pool: AccountPool, tracker: UsageTracker) {
  return async (c: Context<Env>) => {
    const clientIp = c.get('clientIp');
    // 用 text() 读取原始请求体，后续可原样转发；同时 JSON.parse 一份用于日志和用量提取
    const body = await c.req.raw.clone().text();
    const parsedBody = JSON.parse(body) as MessageCreateParams;
    const model = parsedBody.model || 'unknown';
    const sessionId = extractSessionId(parsedBody);

    const preview = formatConversationPreview(parsedBody);
    console.log(`[Request] ${clientIp} | ${model} | session=${sessionId.slice(0, 8)}… | ${c.req.path}\n${preview}`);

    // 429 重试循环：每次从账户池取下一个账户，遇到限流则冷却该账户后换一个重试
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const account = pool.getNext(sessionId);
      if (!account) {
        return c.json({ error: 'all_accounts_rate_limited', message: 'All accounts are in cooldown. Please retry later.' }, 503);
      }

      const url = `${config.glmApiBase}${c.req.path}`;

      // 复制原始请求头，替换为当前账户的 API Key，并清除代理转发的 IP 头
      const headers = new Headers(c.req.raw.headers);
      headers.set('authorization', `Bearer ${account.apiKey}`);
      headers.set('host', new URL(config.glmApiBase).host);
      headers.delete('x-forwarded-for');
      headers.delete('x-real-ip');

      console.log(`[Proxy] -> Account #${account.index} | ${c.req.method} ${c.req.path} | IP: ${clientIp}`);

      try {
        const upstream = await fetch(url, {
          method: c.req.method,
          headers,
          body,
        });

        // 上游返回 429：对该账户执行冷却，跳到下一轮循环换账户重试
        if (upstream.status === 429) {
          const retryAfter = upstream.headers.get('retry-after');
          const cooldownMs = retryAfter ? parseInt(retryAfter) * 1000 : undefined;
          pool.cooldown(account, cooldownMs);
          console.warn(`[Proxy] 429 from Account #${account.index}, retrying...`);
          continue;
        }

        // 非 SSE 响应（普通 JSON 或错误）：直接转发，并从响应体提取 usage
        const contentType = upstream.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          const respBody = await upstream.text();
          trackUsageFromResponse(parsedBody, respBody, upstream.status, account, clientIp, model, pool, tracker);
          return new Response(respBody, {
            status: upstream.status,
            headers: forwardHeaders(upstream),
          });
        }

        // SSE 流式响应：边转发边解析 usage
        return streamResponse(upstream, account, clientIp, model, pool, tracker, parsedBody);
      } catch (err) {
        // 网络层异常也触发重试，最后一次失败则返回 502
        console.error(`[Proxy] Error with Account #${account.index}:`, err);
        if (attempt === MAX_RETRIES - 1) {
          return c.json({ error: 'upstream_error', message: String(err) }, 502);
        }
      }
    }

    // 所有重试都耗尽
    return c.json({ error: 'max_retries_exceeded', message: 'Failed after max retries.' }, 502);
  };
}

// SSE 流式响应处理：边向上游拉取数据边向客户端转发，同时在中间解析 usage token 数据
function streamResponse(
  upstream: Response,
  account: Account,
  clientIp: string,
  model: string,
  pool: AccountPool,
  tracker: UsageTracker,
  parsedBody: MessageCreateParams,
) {
  const reader = upstream.body!.getReader();
  const encoder = new TextEncoder();

  let usageData = { inputTokens: 0, outputTokens: 0 };
  // 缓冲区：SSE 事件可能跨 chunk 分割，需要攒到完整行再解析
  let buffer = '';

  const stream = new ReadableStream({
    // pull 模式：消费端请求多少就拉多少，避免一次性读入大量数据
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // 流结束：刷出缓冲区残余数据，记录本次请求的 token 用量
          if (buffer) {
            controller.enqueue(encoder.encode(buffer));
          }
          tracker.record({
            clientIp,
            model,
            accountIndex: account.index,
            inputTokens: usageData.inputTokens,
            outputTokens: usageData.outputTokens,
            statusCode: 200,
          });
          console.log(`[Proxy] <- Account #${account.index} done | tokens: ${usageData.inputTokens}-${usageData.outputTokens}`);
          eventBus.emitProxyEvent({ accountIndex: account.index, clientIp, model, inputTokens: usageData.inputTokens, outputTokens: usageData.outputTokens });
          controller.close();
          return;
        }

        const chunk = new TextDecoder().decode(value);
        buffer += chunk;

        // 按行拆分 SSE 事件，解析其中的 usage 信息
        const lines = buffer.split('\n');
        buffer = '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const event = JSON.parse(data) as RawMessageStreamEvent;
              // message_start 携带 input tokens（提示词用量）
              if (event.type === 'message_start') {
                usageData.inputTokens = event.message.usage.input_tokens || 0;
                // message_delta 携带 output tokens（增量生成用量）
              } else if (event.type === 'message_delta') {
                usageData.outputTokens = event.usage.output_tokens || 0;
                // message_stop 不携带 usage，仅标记流结束
              }
            } catch {
              // 非 JSON 的 SSE 行，忽略
            }
          }
        }

        // 原样转发 chunk 给客户端
        controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        console.error('[Proxy] Stream error:', err);
        controller.error(err);
      }
    },
    // 客户端断开连接时取消上游 reader，释放资源
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      ...forwardHeaders(upstream),
      // 禁用缓存和 Nginx 缓冲，确保 SSE 数据即时推送
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

// 从非流式（JSON）响应体中提取 token 用量并记录
function trackUsageFromResponse(
  parsedBody: MessageCreateParams,
  responseBody: string,
  statusCode: number,
  account: Account,
  clientIp: string,
  model: string,
  pool: AccountPool,
  tracker: UsageTracker,
) {
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const json = JSON.parse(responseBody) as AnthropicMessage;
    if (json.usage) {
      inputTokens = json.usage.input_tokens || 0;
      outputTokens = json.usage.output_tokens || 0;
    }
  } catch { /* ignore */ }

  tracker.record({
    clientIp,
    model,
    accountIndex: account.index,
    inputTokens,
    outputTokens,
    statusCode,
  });
  eventBus.emitProxyEvent({ accountIndex: account.index, clientIp, model, inputTokens, outputTokens });
}

// 白名单转发上游响应头，只保留客户端需要的几个关键头
function forwardHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const passThrough = ['content-type', 'request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  for (const h of passThrough) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return headers;
}
