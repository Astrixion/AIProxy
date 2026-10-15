// Regression test: claude → claude streaming passthrough must still decloak
// tool names. translateRequest() cloaks client tool names with CLAUDE_TOOL_SUFFIX
// for OAuth-cloaked Claude providers (cloakToolsOnOAuth) even when source and
// target formats match; the same-format fast path in translateResponse() used
// to return chunks untouched, leaking the suffixed name (e.g. "run_code_ide")
// to the client, which then rejected the call as an unknown tool.
import { describe, it, expect, vi } from "vitest";
import "./registerAll.js";
import { translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

// Keep the real handler, SSE transform, and disconnect wrapper; isolate disk writes.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn().mockResolvedValue(undefined),
  saveRequestUsage: vi.fn().mockResolvedValue(undefined),
  appendRequestLog: vi.fn().mockResolvedValue(undefined),
  trackPendingRequest: vi.fn(),
}));

const CLOAKED = "run_code" + CLAUDE_TOOL_SUFFIX;

const toolUseStart = (name) => ({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_01XYZ", name, input: {} }
});

describe("Claude → Claude streaming passthrough (OAuth tool cloak)", () => {
  const state = { toolNameMap: new Map([[CLOAKED, "run_code"]]) };

  it("restores the original tool name on tool_use content_block_start", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, toolUseStart(CLOAKED), state);
    expect(out.content_block.name).toBe("run_code");
  });

  it("leaves uncloaked chunks untouched (identity passthrough)", () => {
    const chunk = toolUseStart("Bash"); // decoy name, not in the map
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, chunk, state);
    expect(out).toBe(chunk);

    const textChunk = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
    const [outText] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, textChunk, state);
    expect(outText).toBe(textChunk);
  });

  it("falls back to suffix-stripping when no cloak map is present", () => {
    const chunk = toolUseStart(CLOAKED);
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, chunk, {});
    expect(out.content_block.name).toBe("run_code");
  });

  it("tolerates the null flush chunk", () => {
    const [out] = translateResponse(FORMATS.CLAUDE, FORMATS.CLAUDE, null, state);
    expect(out).toBeNull();
  });
});

async function streamThroughHandler(sse, toolNameMap) {
  const bytes = new TextEncoder().encode(sse);
  const upstream = new ReadableStream({
    start(controller) {
      // Split event names, JSON strings, and multibyte text across network chunks.
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  const { success, response } = await handleStreamingResponse({
    providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    provider: "claude",
    model: "claude-opus-4-6",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.CLAUDE,
    body: { messages: [] },
    stream: true,
    requestStartTime: Date.now(),
    toolNameMap,
    streamController: createStreamController(),
  });
  expect(success).toBe(true);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return response.text();
}

describe("real Claude streaming handler tool-name restoration", () => {
  const event = (chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`;

  it("restores exactly one mapped name while preserving the rest of the SSE stream", async () => {
    // Both names are legitimate: recursive stripping or a second map lookup
    // would turn read_room_ide into read_room and dispatch the wrong tool.
    const { toolNameMap } = cloakClaudeTools({
      tools: ["read_room", "read_room_ide"].map(name => ({ name, input_schema: { type: "object" } })),
    });
    const before = ': keepalive\n\nevent: ping\ndata: { "type": "ping" }\n\n'
      + event({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 19, output_tokens: 0 } } })
      + event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect phòng 🛠" } })
      + event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } });
    const after = event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"room":"read_room_ide"}' } })
      + event({ type: "content_block_stop", index: 1 })
      + event({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } })
      + event({ type: "message_stop" });
    const upstreamNames = ["read_room_ide", "read_room_ide_ide", "Bash", "unknown_ide"];
    const originalNames = ["read_room", "read_room_ide", "Bash", "unknown_ide"];
    const upstream = before + upstreamNames.map(name => event(toolUseStart(name))).join("") + after;
    const expected = before + originalNames.map(name => event(toolUseStart(name))).join("") + after;

    expect(await streamThroughHandler(upstream, toolNameMap)).toBe(expected + "data: [DONE]\n\n");
  });

  it.each([null, new Map()])("preserves legitimate suffixed names without a rename map (%s)", async (map) => {
    const input = event(toolUseStart("read_room_ide")) + event({ type: "message_stop" });
    expect(await streamThroughHandler(input, map)).toBe(input + "data: [DONE]\n\n");
  });

  it("restores a mapped tool name in the final data line without a newline", async () => {
    const input = event(toolUseStart("read_room_ide")).trimEnd();
    const expected = event(toolUseStart("read_room")).trimEnd();
    expect(await streamThroughHandler(input, new Map([["read_room_ide", "read_room"]])))
      .toBe(expected + "data: [DONE]\n\n");
  });
});
