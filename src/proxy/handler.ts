import type { Context } from 'hono';
import type { AccountPool, Account } from './accountPool.js';
import { config } from '../config.js';
import type { UsageTracker } from '../stats/tracker.js';

type Env = { Variables: { clientIp: string } };

const MAX_RETRIES = 3;

function extractContentPreview(body: any): string {
  try {
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return '(no content)';
    // Take the last user message
    const lastMsg = [...messages].reverse().find((m: any) => m.role === 'user');
    if (!lastMsg) return '(no user message)';
    const text = Array.isArray(lastMsg.content)
      ? lastMsg.content.find((c: any) => c.type === 'text')?.text
      : typeof lastMsg.content === 'string' ? lastMsg.content : null;
    if (!text) return '(no text)';
    return text.length > 80 ? text.slice(0, 80) + '...' : text;
  } catch {
    return '(parse error)';
  }
}

export function createProxyHandler(pool: AccountPool, tracker: UsageTracker) {
  return async (c: Context<Env>) => {
    const clientIp = c.get('clientIp');
    const body = await c.req.raw.clone().text();
    const parsedBody = JSON.parse(body);
    const model = parsedBody.model || 'unknown';

    // Extract a preview of the user's request content
    const content = extractContentPreview(parsedBody);
    console.log(`[Request] ${clientIp} | ${model} | ${c.req.path} | "${content}"`);

    // Try accounts with retry on 429
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const account = pool.getNext();
      if (!account) {
        return c.json({ error: 'all_accounts_rate_limited', message: 'All accounts are in cooldown. Please retry later.' }, 503);
      }

      const url = `${config.glmApiBase}${c.req.path}`;

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

        // Rate limited - cooldown and retry with next account
        if (upstream.status === 429) {
          const retryAfter = upstream.headers.get('retry-after');
          const cooldownMs = retryAfter ? parseInt(retryAfter) * 1000 : undefined;
          pool.cooldown(account, cooldownMs);
          console.warn(`[Proxy] 429 from Account #${account.index}, retrying...`);
          continue;
        }

        // Non-streaming or error response - forward directly
        const contentType = upstream.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
          const respBody = await upstream.text();
          // Try to extract usage from non-streaming response
          trackUsageFromResponse(parsedBody, respBody, upstream.status, account, clientIp, model, pool, tracker);
          return new Response(respBody, {
            status: upstream.status,
            headers: forwardHeaders(upstream),
          });
        }

        // SSE streaming - forward with usage extraction
        return streamResponse(upstream, account, clientIp, model, pool, tracker, parsedBody);
      } catch (err) {
        console.error(`[Proxy] Error with Account #${account.index}:`, err);
        if (attempt === MAX_RETRIES - 1) {
          return c.json({ error: 'upstream_error', message: String(err) }, 502);
        }
      }
    }

    return c.json({ error: 'max_retries_exceeded', message: 'Failed after max retries.' }, 502);
  };
}

function streamResponse(
  upstream: Response,
  account: Account,
  clientIp: string,
  model: string,
  pool: AccountPool,
  tracker: UsageTracker,
  parsedBody: any,
) {
  const reader = upstream.body!.getReader();
  const encoder = new TextEncoder();

  let usageData = { inputTokens: 0, outputTokens: 0 };
  let buffer = '';

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // Flush remaining buffer
          if (buffer) {
            controller.enqueue(encoder.encode(buffer));
          }
          // Record usage
          pool.recordUsage(account, usageData.inputTokens, usageData.outputTokens);
          tracker.record({
            clientIp,
            model,
            accountIndex: account.index,
            inputTokens: usageData.inputTokens,
            outputTokens: usageData.outputTokens,
            statusCode: 200,
          });
          console.log(`[Proxy] <- Account #${account.index} done | tokens: ${usageData.inputTokens}+${usageData.outputTokens}`);
          controller.close();
          return;
        }

        const chunk = new TextDecoder().decode(value);
        buffer += chunk;

        // Parse SSE events to extract usage
        const lines = buffer.split('\n');
        buffer = '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const event = JSON.parse(data);
              if (event.type === 'message_start' && event.message?.usage) {
                usageData.inputTokens = event.message.usage.input_tokens || 0;
              } else if (event.type === 'message_delta' && event.usage) {
                usageData.outputTokens = event.usage.output_tokens || 0;
              } else if (event.type === 'message_stop' && event.message?.usage) {
                usageData.inputTokens = event.message.usage.input_tokens || usageData.inputTokens;
                usageData.outputTokens = event.message.usage.output_tokens || usageData.outputTokens;
              }
            } catch {
              // Non-JSON SSE line, ignore
            }
          }
        }

        controller.enqueue(encoder.encode(chunk));
      } catch (err) {
        console.error('[Proxy] Stream error:', err);
        controller.error(err);
      }
    },
    cancel() {
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

function trackUsageFromResponse(
  parsedBody: any,
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
    const json = JSON.parse(responseBody);
    if (json.usage) {
      inputTokens = json.usage.input_tokens || 0;
      outputTokens = json.usage.output_tokens || 0;
    }
  } catch { /* ignore */ }

  pool.recordUsage(account, inputTokens, outputTokens);
  tracker.record({
    clientIp,
    model,
    accountIndex: account.index,
    inputTokens,
    outputTokens,
    statusCode,
  });
}

function forwardHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const passThrough = ['content-type', 'request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
  for (const h of passThrough) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return headers;
}
