import { completeProviderRequest, startProviderRequest } from "@/lib/localDb";

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const input = numeric(value.input_tokens ?? value.prompt_tokens);
  const output = numeric(value.output_tokens ?? value.completion_tokens);
  const cacheRead = numeric(
    value.cache_read_input_tokens
    ?? value.cached_tokens
    ?? value.input_tokens_details?.cached_tokens
    ?? value.prompt_tokens_details?.cached_tokens
  );
  const cacheWrite = numeric(
    value.cache_creation_input_tokens
    ?? value.prompt_tokens_details?.cache_creation_tokens
  );
  if ([input, output, cacheRead, cacheWrite].every((item) => item === null)) return null;
  return { input, output, cacheRead, cacheWrite };
}

function findUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const direct = normalizeUsage(value.usage);
  if (direct) return direct;
  for (const nested of Object.values(value)) {
    const found = findUsage(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function inspectJson(text) {
  try {
    return findUsage(JSON.parse(text));
  } catch {
    return null;
  }
}

async function observeBody(stream, requestId, responseStatus, contentType) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let body = "";
  let usage = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (contentType.includes("text/event-stream")) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const found = inspectJson(line.slice(5).trim());
          if (found) usage = found;
        }
      } else if (body.length < 2 * 1024 * 1024) {
        body += text;
      }
    }
    if (!contentType.includes("text/event-stream")) usage = inspectJson(body) || usage;
    await completeProviderRequest(requestId, {
      status: responseStatus >= 200 && responseStatus < 300 ? "complete" : `http_${responseStatus}`,
      usage: {
        input: usage?.input ?? null,
        output: usage?.output ?? null,
        cacheRead: usage?.cacheRead ?? null,
        cacheWrite: usage?.cacheWrite ?? null,
        complete: true,
      },
    });
  } catch {
    await completeProviderRequest(requestId, {
      status: "incomplete",
      usage: usage ? { ...usage, complete: false } : { complete: false },
    });
  }
}

export async function beginProviderRequest({ credential, virtualKey, member }) {
  const slash = member.model.indexOf("/");
  return startProviderRequest({
    externalSessionId: credential?.externalSessionId,
    tokenId: credential?.id,
    slot: credential?.slot,
    virtualKey,
    provider: slash === -1 ? "unknown" : member.model.slice(0, slash),
    upstreamModel: member.model,
    connectionId: member.connectionId,
  });
}

export function observeProviderResponse(response, requestId) {
  if (!response?.body) {
    completeProviderRequest(requestId, {
      status: response?.ok ? "complete" : `http_${response?.status || 500}`,
    }).catch(() => {});
    return response;
  }
  const [clientBody, observerBody] = response.body.tee();
  observeBody(
    observerBody,
    requestId,
    response.status,
    response.headers.get("content-type") || ""
  ).catch(() => {});
  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
