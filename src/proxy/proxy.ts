import type { Context } from 'hono';
import type { AccountBalancer, Account } from './accountBalancer.js';
import { config } from '../config.js';
import type { RequestLog } from '../stats/requestLog.js';
import { eventBus } from '../admin/events.js';
import type {
  MessageCreateParams,
  ContentBlockParam,
  // 以下类型在注释的 SSE token 解析代码中使用，后续可能复用
  RawMessageStreamEvent,
  Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

type Env = { Variables: { clientIp: string } };

// 429（限流）时最多重试的账户切换次数
const MAX_RETRIES = 3;

const MAX_RETRY_AFTER_MS = 60 * 60 * 1000; // 最大冷却 1 小时

/** 解析 Retry-After 头，支持秒数或 HTTP-date 格式 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  // 纯数字秒数
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && String(seconds) === trimmed) {
    if (seconds <= 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date 格式
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    if (delta <= 0) return undefined;
    return Math.min(delta, MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

// 提取请求中所有 content block 的去重类型列表
function extractContentTypes(body: MessageCreateParams): string[] {
  const types = new Set<string>();
  for (const msg of body.messages) {
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text' as const }]
      : (msg.content as ContentBlockParam[]);
    for (const b of blocks) types.add(b.type);
  }
  return [...types];
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

export function createProxyHandler(pool: AccountBalancer, tracker: RequestLog) {
  return async (c: Context<Env>) => {
    const clientIp = c.get('clientIp');
    const body = await c.req.raw.clone().text();
    const parsedBody = JSON.parse(body) as MessageCreateParams;
    const model = parsedBody.model || 'unknown';
    const sessionId = extractSessionId(parsedBody);
    const contentTypes = extractContentTypes(parsedBody);
    const isNewSession = !pool.hasSession(sessionId);
    const shortSid = sessionId.slice(0, 12);

    // 429 重试循环：每次从账户池取下一个账户，遇到限流则冷却该账户后换一个重试
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const account = pool.getNext(sessionId);
      if (!account) {
        return c.json({ error: 'all_accounts_rate_limited', message: 'All accounts are in cooldown. Please retry later.' }, 503);
      }

      // 新会话绑定日志
      if (isNewSession && attempt === 0) {
        console.log(`[Session] 新会话 ${shortSid}… → Account #${account.index}`);
        eventBus.emitProxyEvent({ accountIndex: account.index, clientIp, model, sessionId: shortSid, type: 'bind', statusCode: 0, contentTypes });
      }

      const url = `${config.glmApiBase}${c.req.path}`;

      // 复制原始请求头，替换为当前账户的 API Key，并清除代理转发的 IP 头
      const headers = new Headers(c.req.raw.headers);
      headers.set('authorization', `Bearer ${account.apiKey}`);
      headers.set('host', new URL(config.glmApiBase).host);
      headers.delete('x-forwarded-for');
      headers.delete('x-real-ip');

      try {
        const upstream = await fetch(url, {
          method: c.req.method,
          headers,
          body,
        });

        // 上游返回 429：对该账户执行冷却，跳到下一轮循环换账户重试
        if (upstream.status === 429) {
          const retryAfter = upstream.headers.get('retry-after');
          const cooldownMs = parseRetryAfter(retryAfter);
          pool.cooldown(account, cooldownMs);
          console.warn(`[Proxy] 429 from Account #${account.index}, retrying...`);
          continue;
        }

        // 非 SSE 响应（普通 JSON 或错误）：直接转发
        const contentType = upstream.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          const respBody = await upstream.text();
          recordUsage(tracker, account, clientIp, model, upstream.status, shortSid, contentTypes);
          return new Response(respBody, {
            status: upstream.status,
            headers: forwardHeaders(upstream),
          });
        }

        // SSE 流式响应：边转发边解析 usage
        return streamResponse(upstream, account, clientIp, model, tracker, shortSid, contentTypes);
      } catch (err) {
        // 网络层异常也触发重试，最后一次失败则返回 502
        console.error(`[Proxy] Error with Account #${account.index}:`, err);
        if (attempt === MAX_RETRIES - 1) {
          return c.json({ error: 'upstream_error', message: String(err) }, 502);
        }
      }
    }

    return c.json({ error: 'max_retries_exceeded', message: 'Failed after max retries.' }, 502);
  };
}

// SSE 流式响应处理：边向上游拉取数据边向客户端转发
function streamResponse(
  upstream: Response,
  account: Account,
  clientIp: string,
  model: string,
  tracker: RequestLog,
  shortSid: string,
  contentTypes: string[],
) {
  const reader = upstream.body!.getReader();
  let recorded = false;

  const recordOnce = (statusCode: number) => {
    if (recorded) return;
    recorded = true;
    recordUsage(tracker, account, clientIp, model, statusCode, shortSid, contentTypes);
  };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          recordOnce(200);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        console.error('[Proxy] Stream error:', err);
        recordOnce(502);
        controller.error(err);
      }
    },
    cancel() {
      recordOnce(499);
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      ...forwardHeaders(upstream),
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

// === 以下 SSE token 解析代码暂时不用，后续可能复用 ===
//
// function streamResponseWithTokenTracking(...) {
//   const reader = upstream.body!.getReader();
//   const encoder = new TextEncoder();
//   let totalTokens = 0;
//   let buffer = '';
//
//   const stream = new ReadableStream({
//     async pull(controller) {
//       try {
//         const { done, value } = await reader.read();
//         if (done) {
//           if (buffer) controller.enqueue(encoder.encode(buffer));
//           recordUsage(tracker, account, clientIp, model, 200, totalTokens);
//           controller.close();
//           return;
//         }
//         const chunk = new TextDecoder().decode(value);
//         buffer += chunk;
//         const lines = buffer.split('\n');
//         buffer = '';
//         for (const line of lines) {
//           if (line.startsWith('data: ')) {
//             const data = line.slice(6).trim();
//             if (data === '[DONE]') continue;
//             try {
//               const event = JSON.parse(data) as RawMessageStreamEvent;
//               if (event.type === 'message_start') {
//                 totalTokens += event.message.usage.input_tokens || 0;
//               } else if (event.type === 'message_delta') {
//                 totalTokens += event.usage.output_tokens || 0;
//               }
//             } catch { /* 非 JSON 的 SSE 行 */ }
//           }
//         }
//         controller.enqueue(encoder.encode(chunk));
//       } catch (err) {
//         console.error('[Proxy] Stream error:', err);
//         controller.error(err);
//       }
//     },
//     cancel() { reader.cancel(); },
//   });
//   ...
// }
//
// function extractTokensFromJson(responseBody: string): number {
//   try {
//     const json = JSON.parse(responseBody) as AnthropicMessage;
//     if (json.usage) {
//       return (json.usage.input_tokens || 0) + (json.usage.output_tokens || 0);
//     }
//   } catch { /* ignore */ }
//   return 0;
// }

// 统一记录用量
function recordUsage(tracker: RequestLog, account: Account, clientIp: string, model: string, statusCode: number, shortSid: string, contentTypes: string[]) {
  tracker.record({ clientIp, model, accountIndex: account.index, statusCode });
  const types = contentTypes.join(',');
  console.log(`[Proxy] session=${shortSid}… account=#${account.index} model=${model} | ${types} ${statusCode}`);
  eventBus.emitProxyEvent({ accountIndex: account.index, clientIp, model, sessionId: shortSid, type: 'request', statusCode, contentTypes });
}

// 白名单转发上游响应头
function forwardHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const passThrough = ['content-type', 'request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  for (const h of passThrough) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return headers;
}
