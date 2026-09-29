const CREATED_AT = "1970-01-01T00:00:00Z";

export function virtualModel(keyName) {
  return {
    type: "model",
    id: keyName,
    display_name: keyName,
    created_at: CREATED_AT,
  };
}

export function anthropicError(status, errorType, message) {
  return Response.json(
    { type: "error", error: { type: errorType, message } },
    { status }
  );
}

export function validateMessagesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Messages requests must contain a JSON object body.";
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return "Messages requests must name a non-empty model.";
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    return "Messages requests must set max_tokens to a positive integer.";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "Messages requests must contain at least one message.";
  }
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return "Every message must be an object.";
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return "Every message role must be user or assistant.";
    }
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return "Every message must contain text or a non-empty content block array.";
    }
    if (message.content.some((block) => !block || typeof block !== "object" || Array.isArray(block))) {
      return "Every message content block must be an object.";
    }
    if (message.content.some((block) => typeof block.type !== "string" || !block.type.trim())) {
      return "Every message content block must name its type.";
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return "stream must be a boolean.";
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools must be an array.";
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)
        || typeof tool.name !== "string" || !tool.name.trim()
        || !tool.input_schema || typeof tool.input_schema !== "object"
        || Array.isArray(tool.input_schema)) {
        return "Every tool must have a non-empty name and an input_schema object.";
      }
    }
  }
  return null;
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function usageToAnthropic(usage = {}) {
  return {
    input_tokens: Number(usage.input_tokens ?? usage.prompt_tokens) || 0,
    output_tokens: Number(usage.output_tokens ?? usage.completion_tokens) || 0,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0 }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0 }
      : {}),
  };
}

function chatCompletionToAnthropic(body, virtualModelName) {
  const choice = body?.choices?.[0];
  if (!choice) return null;
  const message = choice.message || {};
  const content = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name || call.name || "",
      input: parseArguments(call.function?.arguments ?? call.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const stopReason = choice.finish_reason === "tool_calls"
    ? "tool_use"
    : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
  return {
    id: String(body.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, "msg_"),
    type: "message",
    role: "assistant",
    model: virtualModelName,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageToAnthropic(body.usage),
  };
}

function responsesToAnthropic(body, virtualModelName) {
  if (body?.object !== "response" || !Array.isArray(body.output)) return null;
  const content = [];
  for (const item of body.output) {
    if (item.type === "reasoning") {
      const thinking = (item.summary || []).map((part) => part.text || "").join("");
      if (thinking) content.push({ type: "thinking", thinking });
    } else if (item.type === "message") {
      const text = (item.content || []).map((part) => part.text || "").join("");
      if (text) content.push({ type: "text", text });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name || "",
        input: parseArguments(item.arguments ?? item.input),
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: String(body.id || `msg_${Date.now()}`).replace(/^resp_/, "msg_"),
    type: "message",
    role: "assistant",
    model: virtualModelName,
    content,
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: usageToAnthropic(body.usage),
  };
}

function normalizeMessage(body, virtualModelName) {
  if (body?.type === "message") return { ...body, model: virtualModelName };
  return chatCompletionToAnthropic(body, virtualModelName)
    || responsesToAnthropic(body, virtualModelName);
}

function rewriteSseEvent(event, virtualModelName) {
  const lines = event.split(/\r?\n/);
  return lines.map((line) => {
    if (!line.startsWith("data:")) return line;
    const raw = line.slice(5).trim();
    try {
      const value = JSON.parse(raw);
      if (value?.message?.model) value.message.model = virtualModelName;
      if (value?.model) value.model = virtualModelName;
      return `data: ${JSON.stringify(value)}`;
    } catch {
      return line;
    }
  }).join("\n");
}

function normalizeSse(body, virtualModelName) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let closed = false;
  let timer;
  return new ReadableStream({
    async start(controller) {
      timer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
      }, 25000);
      let pending = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const event = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            controller.enqueue(encoder.encode(`${rewriteSseEvent(event, virtualModelName)}\n\n`));
          }
        }
        if (pending) controller.enqueue(encoder.encode(rewriteSseEvent(pending, virtualModelName)));
        closed = true;
        clearInterval(timer);
        controller.close();
      } catch (error) {
        closed = true;
        clearInterval(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      closed = true;
      clearInterval(timer);
      await reader.cancel(reason);
    },
  });
}

export async function normalizeFacadeResponse(response, virtualModelName, wantsStream) {
  if (!response.ok) {
    let message = `Provider request failed with status ${response.status}.`;
    try {
      const body = await response.json();
      message = body?.error?.message || body?.error || body?.message || message;
    } catch { /* keep generic message */ }
    const errorType = response.status === 401 || response.status === 403
      ? "authentication_error"
      : response.status === 429 || response.status === 503
        ? "overloaded_error"
        : response.status >= 500 ? "api_error" : "invalid_request_error";
    return anthropicError(response.status, errorType, String(message));
  }

  if (wantsStream) {
    return new Response(normalizeSse(response.body, virtualModelName), {
      status: response.status,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const body = await response.json();
  const normalized = normalizeMessage(body, virtualModelName);
  return normalized
    ? Response.json(normalized)
    : anthropicError(502, "api_error", "Provider returned an invalid Messages response.");
}
