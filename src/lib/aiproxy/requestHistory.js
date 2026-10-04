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
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mergeUsage(current, observed) {
  if (!observed) return current;
  const merged = { ...(current || {}) };
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (observed[field] !== null) merged[field] = observed[field];
  }
  return merged;
}

function inspectEvent(raw, state) {
  if (raw === "[DONE]") {
    state.terminalSuccess = true;
    return;
  }
  const value = inspectJson(raw);
  if (!value) return;
  state.usage = mergeUsage(state.usage, findUsage(value));
  if (value.type === "message_stop" || value.type === "response.completed") {
    state.terminalSuccess = true;
  }
  if (value.type === "error" || value.type === "response.failed" || value.error) {
    state.terminalError = true;
  }
}

function observeBody(stream, requestId, responseStatus, contentType) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const isSse = contentType.includes("text/event-stream");
  const state = {
    pending: "",
    body: "",
    usage: null,
    terminalSuccess: false,
    terminalError: false,
    finalized: false,
  };

  function inspectChunk(value, final = false) {
    const text = decoder.decode(value, { stream: !final }).replace(/\r\n/g, "\n");
    if (!isSse) {
      if (state.body.length < 2 * 1024 * 1024) state.body += text;
      return;
    }
    state.pending += text;
    const lines = state.pending.split("\n");
    state.pending = final ? "" : lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data:")) inspectEvent(line.slice(5).trim(), state);
    }
  }

  async function finalize(status) {
    if (state.finalized) return;
    state.finalized = true;
    if (!isSse) state.usage = mergeUsage(state.usage, findUsage(inspectJson(state.body)));
    const usage = state.usage
      ? {
          input: state.usage.input ?? null,
          output: state.usage.output ?? null,
          cacheRead: state.usage.cacheRead ?? null,
          cacheWrite: state.usage.cacheWrite ?? null,
          complete: status === "complete",
        }
      : null;
    try {
      await completeProviderRequest(requestId, { status, usage });
    } catch {
      // History must never change inference outcome.
    }
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (!done) {
          inspectChunk(value);
          controller.enqueue(value);
          return;
        }
        inspectChunk(undefined, true);
        const status = responseStatus < 200 || responseStatus >= 300
          ? `http_${responseStatus}`
          : isSse
            ? state.terminalError ? "protocol_error" : state.terminalSuccess ? "complete" : "incomplete"
            : "complete";
        await finalize(status);
        controller.close();
      } catch (error) {
        await finalize("incomplete");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finalize("cancelled");
      }
    },
  });
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
  const clientBody = observeBody(
    response.body,
    requestId,
    response.status,
    response.headers.get("content-type") || ""
  );
  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
