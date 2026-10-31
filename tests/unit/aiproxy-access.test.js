import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalSessionSecret = process.env.AIPROXY_SESSION_TOKEN_SECRET;
let tempDir;
let db;
let adapter;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiproxy-access-"));
  process.env.DATA_DIR = tempDir;
  process.env.AIPROXY_SESSION_TOKEN_SECRET = "test-session-secret-that-is-at-least-32-characters";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  ({ getAdapter: adapter } = await import("@/lib/db/driver.js"));
  await db.initDb();
  adapter = await adapter();

  await db.upsertProviderKeyState("primary-key", "round-robin", [
    { model: "claude/test", connectionId: "account-a" },
  ]);
  await db.upsertProviderKeyState("vision-key", "round-robin", [
    { model: "claude/vision", connectionId: "account-b" },
  ]);
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSessionSecret === undefined) delete process.env.AIPROXY_SESSION_TOKEN_SECRET;
  else process.env.AIPROXY_SESSION_TOKEN_SECRET = originalSessionSecret;
});

describe("AIProxy scoped credentials", () => {
  it("treats allowed keys literally and never as wildcards", async () => {
    const { validateAllowedKeys } = await import("@/lib/aiproxy/accessControl.js");

    await expect(validateAllowedKeys(["primary-key", "all"]))
      .resolves.toEqual(["primary-key", "all"]);
    await expect(validateAllowedKeys(["*"]))
      .rejects.toThrow("Unknown provider key '*'");
  });

  it("stores only the hash of a manual token", async () => {
    const issued = await db.createManualAccessToken("operator", ["primary-key"]);
    const row = adapter.get(`SELECT * FROM accessTokens WHERE id = ?`, [issued.record.id]);

    expect(issued.token).toMatch(/^aip_sk_/);
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.resolveAccessToken(issued.token)).toMatchObject({
      id: issued.record.id,
      allowedKeys: ["primary-key"],
    });
  });

  it("reissues the same session credential for the same session and slot", async () => {
    const first = await db.upsertSessionAccessToken({
      externalSessionId: "session-1",
      slot: "primary",
      name: "coordinator",
      allowedKeys: ["primary-key"],
    });
    const retry = await db.upsertSessionAccessToken({
      externalSessionId: "session-1",
      slot: "primary",
      name: "coordinator retry",
      allowedKeys: ["primary-key"],
    });

    expect(retry.token).toBe(first.token);
    expect(retry.record.id).toBe(first.record.id);
    expect(retry.record.allowedKeys).toEqual(["primary-key"]);
    expect(adapter.get(
      `SELECT COUNT(*) AS count FROM accessTokens WHERE externalSessionId = ? AND slot = ?`,
      ["session-1", "primary"]
    ).count).toBe(1);
  });

  it("rejects scope changes and never resurrects revoked session credentials", async () => {
    await expect(db.upsertSessionAccessToken({
      externalSessionId: "session-1",
      slot: "primary",
      name: "changed",
      allowedKeys: ["vision-key"],
    })).rejects.toMatchObject({ statusCode: 409 });

    await db.revokeSessionAccessTokens("session-1");
    await expect(db.upsertSessionAccessToken({
      externalSessionId: "session-1",
      slot: "primary",
      name: "revived",
      allowedKeys: ["primary-key"],
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("revokes every credential for a permanently deleted session", async () => {
    const vision = await db.upsertSessionAccessToken({
      externalSessionId: "session-to-delete",
      slot: "browser-vision",
      name: "browser",
      allowedKeys: ["vision-key"],
    });

    expect(await db.revokeSessionAccessTokens("session-to-delete")).toBe(1);
    expect(await db.resolveAccessToken(vision.token)).toBeNull();
  });

  it("fences credentials for slots that were not issued before session revocation", async () => {
    await db.revokeSessionAccessTokens("never-issued-session");

    await expect(db.upsertSessionAccessToken({
      externalSessionId: "never-issued-session",
      slot: "browser-vision",
      name: "late browser credential",
      allowedKeys: ["vision-key"],
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reconciles orphan sessions without revoking active sessions", async () => {
    const active = await db.upsertSessionAccessToken({
      externalSessionId: "active-session",
      slot: "primary",
      name: "active",
      allowedKeys: ["primary-key"],
    });
    const orphan = await db.upsertSessionAccessToken({
      externalSessionId: "orphan-session",
      slot: "primary",
      name: "orphan",
      allowedKeys: ["primary-key"],
    });

    const afterGrace = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(await db.reconcileSessionAccessTokens(["active-session"], afterGrace))
      .toEqual(["orphan-session"]);
    expect(await db.resolveAccessToken(active.token)).not.toBeNull();
    expect(await db.resolveAccessToken(orphan.token)).toBeNull();
  });

  it("stores request metadata without prompts, responses, or credentials", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
    await db.saveRequestDetail({
      id: "metadata-only",
      provider: "claude",
      model: "test",
      connectionId: "account-a",
      status: "success",
      request: {
        headers: { authorization: "Bearer plaintext-secret" },
        body: { messages: [{ role: "user", content: "private prompt" }] },
      },
      providerRequest: { apiKey: "provider-secret" },
      providerResponse: { content: "private provider response" },
      response: { content: "private response" },
      tokens: { prompt_tokens: 2, completion_tokens: 3 },
    });

    let detail = null;
    for (let attempt = 0; attempt < 20 && !detail; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      detail = await db.getRequestDetailById("metadata-only");
    }
    expect(detail).toMatchObject({
      provider: "claude",
      model: "test",
      connectionId: "account-a",
      tokens: { prompt_tokens: 2, completion_tokens: 3 },
    });
    expect(detail).not.toHaveProperty("request");
    expect(JSON.stringify(detail)).not.toContain("private");
    expect(JSON.stringify(detail)).not.toContain("secret");
  });

  it("records content-free provider history by external session", async () => {
    const request = await db.startProviderRequest({
      externalSessionId: "trace-session",
      tokenId: "token-id",
      slot: "primary",
      virtualKey: "primary-key",
      provider: "claude",
      upstreamModel: "claude/test",
      connectionId: "account-a",
    });
    await db.completeProviderRequest(request.id, {
      status: "complete",
      usage: { input: 2, output: 3, cacheRead: null, cacheWrite: null, complete: true },
    });

    const [stored] = await db.getProviderRequestsForSession("trace-session");
    expect(stored).toMatchObject({
      virtualKey: "primary-key",
      connectionId: "account-a",
      usage: { input: 2, output: 3, complete: true },
    });
    expect(JSON.stringify(stored)).not.toContain("prompt");
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  it("merges cumulative stream usage and requires a terminal success event", async () => {
    const started = await db.startProviderRequest({
      externalSessionId: "stream-session",
      tokenId: "token-id",
      slot: "primary",
      virtualKey: "primary-key",
      provider: "claude",
      upstreamModel: "claude/test",
      connectionId: "account-a",
    });
    const { observeProviderResponse } = await import("@/lib/aiproxy/requestHistory.js");
    const upstream = new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });

    await observeProviderResponse(upstream, started.id).text();
    const [stored] = await db.getProviderRequestsForSession("stream-session");
    expect(stored).toMatchObject({
      status: "complete",
      usage: { input: 11, output: 7, complete: true },
    });
  });

  it("marks a cleanly truncated stream incomplete instead of successful", async () => {
    const started = await db.startProviderRequest({
      externalSessionId: "truncated-session",
      tokenId: "token-id",
      slot: "primary",
      virtualKey: "primary-key",
      provider: "claude",
      upstreamModel: "claude/test",
      connectionId: "account-a",
    });
    const { observeProviderResponse } = await import("@/lib/aiproxy/requestHistory.js");
    const upstream = new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await observeProviderResponse(upstream, started.id).text();
    const [stored] = await db.getProviderRequestsForSession("truncated-session");
    expect(stored).toMatchObject({
      status: "incomplete",
      usage: { input: 5, complete: false },
    });
  });

  it("does not accept scoped credentials as general 9Router API keys", async () => {
    const issued = await db.createManualAccessToken("scoped-only", ["primary-key"]);
    const { isValidApiKey } = await import("@/sse/services/auth.js");
    expect(await isValidApiKey(issued.token)).toBe(false);
  });
});

describe("AIProxy dashboard management", () => {
  let route;
  let NextRequest;
  let cookie;
  let account;

  beforeAll(async () => {
    route = await import("@/app/api/provider-facade/route.js");
    ({ NextRequest } = await import("next/server"));
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    cookie = `auth_token=${await createDashboardAuthToken()}`;
    account = await db.createProviderConnection({
      provider: "claude", authType: "apikey", name: "Dashboard account",
      apiKey: "never-expose-account-secret", refreshToken: "never-expose-refresh-secret",
    });
  });

  function request(body, query = "", headers = {}) {
    return new NextRequest(`http://localhost/api/provider-facade${query}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("requires dashboard login even without requireLogin and rejects cross-origin mutation", async () => {
    await db.updateSettings({ requireLogin: false });
    const scoped = await db.createManualAccessToken("not-an-admin", ["primary-key"]);
    expect((await route.GET(request(null, "", { cookie: "", authorization: `Bearer ${scoped.token}` }))).status).toBe(401);
    expect((await route.POST(request({ action: "setDefault", name: "primary-key" }, "", { origin: "https://attacker.example" }))).status).toBe(403);
    expect((await route.POST(request({ action: "setDefault", name: "primary-key" }, "", { origin: "" }))).status).toBe(403);
    expect((await route.POST(request({ action: "setDefault", name: "primary-key" }, "", {
      host: "127.0.0.1:20128", origin: "http://127.0.0.1:20128",
    }))).status).toBe(200);
    expect((await route.POST(request({ action: "setDefault", name: "primary-key" }, "", {
      host: "127.0.0.1:20128", origin: "http://attacker.example", "x-forwarded-host": "attacker.example",
    }))).status).toBe(403);
  });

  it("edits exact-account slash-named keys and default without changing their identity", async () => {
    const body = { action: "saveKey", name: "anthropic/demo", strategy: "fill-first",
      members: [{ connectionId: account.id, model: "claude/demo" }] };
    expect((await route.POST(request(body))).status).toBe(200);
    const edited = await route.POST(request({ ...body, strategy: "least-used" }));
    expect(await edited.json()).toMatchObject({ name: "anthropic/demo", strategy: "least-used", members: body.members });
    const invalid = await route.POST(request({ ...body, members: [{ connectionId: account.id, model: "openai/gpt-4o" }] }));
    expect(invalid.status).toBe(400);
    const defaults = await route.POST(request({ action: "setDefault", name: body.name }));
    expect(await defaults.json()).toEqual({ defaultKey: body.name });
  });

  it("shows secrets only on issue, preserves scopes, and revokes subsequent access", async () => {
    const created = await route.POST(request({ action: "createToken", name: "manual dashboard client", allowedKeys: ["primary-key", "vision-key"] }));
    expect(created.status).toBe(201);
    const issued = await created.json();
    expect(await db.resolveAccessToken(issued.token)).toMatchObject({ allowedKeys: ["primary-key", "vision-key"] });
    const response = await route.GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    const listing = await response.json();
    expect(listing.tokens.find((token) => token.id === issued.id)).toMatchObject({ name: "manual dashboard client", isActive: true });
    expect(JSON.stringify(listing)).not.toContain(issued.token);
    expect(JSON.stringify(listing)).not.toContain("tokenHash");
    expect(JSON.stringify(listing)).not.toContain("never-expose");
    const invalid = await route.POST(request({ action: "createToken", name: "wildcard", allowedKeys: ["*"] }));
    expect(invalid.status).toBe(400);
    expect((await route.POST(request({ action: "revokeToken", id: issued.id }))).status).toBe(200);
    expect(await db.resolveAccessToken(issued.token)).toBeNull();
    const after = await (await route.GET(request())).json();
    expect(after.tokens.find((token) => token.id === issued.id).isActive).toBe(false);
  });

  it("separates manual and session history, fails closed for empty session, and retains history on key deletion", async () => {
    const manual = await db.startProviderRequest({ virtualKey: "anthropic/demo", provider: "claude",
      upstreamModel: "claude/demo", connectionId: account.id });
    const read = async (query) => (await (await route.GET(request(null, query))).json()).requests;
    expect((await read("?kind=manual")).map((row) => row.id)).toEqual([manual.id]);
    const sessions = await read("?kind=session");
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((row) => row.externalSessionId !== null)).toBe(true);
    expect((await read("?sessionId=trace-session")).map((row) => row.externalSessionId)).toEqual(["trace-session"]);
    expect(await read("?sessionId=")).toEqual([]);
    expect(await db.getProviderRequestsForSession("")).toEqual([]);
    expect((await read("?limit=1")).length).toBe(1);
    expect((await route.POST(request({ action: "deleteKey", name: "anthropic/demo" }))).status).toBe(200);
    expect((await read("?kind=manual"))[0].id).toBe(manual.id);
    expect(await db.getDefaultProviderKey()).toBeNull();
  });

  it("discovers the reserved all pool for lifecycle callers without making it editable", async () => {
    const original = process.env.AIPROXY_CONTROL_TOKEN;
    process.env.AIPROXY_CONTROL_TOKEN = "synthetic-control-token";
    try {
      const internal = await import("@/app/api/internal/provider-keys/route.js");
      expect((await internal.GET(request())).status).toBe(401);
      const response = await internal.GET(request(null, "", { authorization: "Bearer synthetic-control-token" }));
      const catalog = await response.json();
      expect(catalog.keys.find(key => key.name === "all")).toMatchObject({
        strategy: "round-robin", contextWindow: 200000, maxTokens: 32768,
        members: [
          { model: "claude/test", connectionId: "account-a" },
          { model: "claude/vision", connectionId: "account-b" },
        ],
      });
      const dashboard = await (await route.GET(request())).json();
      expect(dashboard.keys.some(key => key.name === "all")).toBe(false);
    } finally {
      if (original === undefined) delete process.env.AIPROXY_CONTROL_TOKEN;
      else process.env.AIPROXY_CONTROL_TOKEN = original;
    }
  });
});

describe("AIProxy Anthropic facade", () => {
  it("rejects malformed Messages requests before routing", async () => {
    const { validateMessagesRequest } = await import("@/lib/aiproxy/anthropicFacade.js");
    expect(validateMessagesRequest({ model: "primary-key", messages: [] }))
      .toBe("Messages requests must set max_tokens to a positive integer.");
    expect(validateMessagesRequest({
      model: "primary-key",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    })).toBeNull();
  });

  it("normalizes JSON responses to Anthropic Messages with the virtual model", async () => {
    const { normalizeFacadeResponse } = await import("@/lib/aiproxy/anthropicFacade.js");
    const upstream = Response.json({
      id: "chatcmpl-1",
      choices: [{
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: '{"id":7}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    });

    const response = await normalizeFacadeResponse(upstream, "primary-key", false);
    await expect(response.json()).resolves.toMatchObject({
      type: "message",
      model: "primary-key",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", name: "lookup", input: { id: 7 } },
      ],
      usage: { input_tokens: 11, output_tokens: 5 },
    });
  });

  it("rewrites streaming model identities to the virtual key", async () => {
    const { normalizeFacadeResponse } = await import("@/lib/aiproxy/anthropicFacade.js");
    const upstream = new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude/test"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );

    const response = await normalizeFacadeResponse(upstream, "primary-key", true);
    const body = await response.text();
    expect(body).toContain('"model":"primary-key"');
    expect(body).not.toContain("claude/test");
  });
});

describe("AIProxy provider-key routing", () => {
  const members = [
    { model: "claude/a", connectionId: "account-a" },
    { model: "claude/b", connectionId: "account-b" },
  ];

  it.each([
    [["claude/claude-sonnet-4-6"], 200000],
    [["cc/claude-sonnet-4.6"], 200000],
    [["cc/CLAUDE-SONNET-4-6-20260217"], 200000],
    [["anthropic/claude-sonnet-4-6"], 200000],
    [["anthropic-compatible-test/claude-sonnet-4-6"], 200000],
    [["openai-compatible-test/claude-sonnet-4.6"], 200000],
    [["claude-sonnet-4-6"], 200000],
    [["claude/claude-sonnet-4.60"], 200000],
    [["claude/claude-opus-4-6"], 200000],
    [["cc/claude-opus-5.5"], 200000],
    [["kimi/k3"], 1048576],
    [["kimi/k3", "claude/claude-sonnet-4-6"], 200000],
    [["codex/gpt-5.6-sol-high"], 372000],
    [["cx/gpt-5.6-sol(high)"], 372000],
    [["codex/gpt-5.6-sol[1m](high)"], 872000],
    [["codex/gpt-5.6-terra"], 272000],
    [["openai/gpt-5.6-sol"], 1050000],
    [["kimi/k3", "codex/gpt-5.6-sol-high"], 372000],
    [["codex/gpt-5.6-sol-high", "openai/gpt-4o"], 128000],
    [["openai/gpt-4o", "codex/gpt-5.6-sol-high"], 128000],
    [["kimi/k3", "unknown/unknown-model"], 200000],
  ])("advertises the conservative context minimum for %j as %i", async (models, contextWindow) => {
    const { getProviderKeyDescriptor } = await import("@/lib/aiproxy/providerKeys.js");
    await db.upsertProviderKeyState("context-key", "round-robin",
      models.map((model, index) => ({ model, connectionId: `context-account-${index}` })));
    try {
      expect(await getProviderKeyDescriptor("context-key")).toMatchObject({ contextWindow });
    } finally {
      await db.deleteProviderKeyState("context-key");
    }
  });

  it("persists round-robin position", async () => {
    await db.upsertProviderKeyState("round-robin-key", "round-robin", members);
    const first = await db.selectProviderKeyMembers("round-robin-key", members);
    const second = await db.selectProviderKeyMembers("round-robin-key", members);

    expect(first[0].connectionId).toBe("account-a");
    expect(second[0].connectionId).toBe("account-b");
  });

  it("uses persisted request counts for least-used selection", async () => {
    await db.upsertProviderKeyState("least-used-key", "least-used", members);
    const first = await db.selectProviderKeyMembers("least-used-key", members);
    const second = await db.selectProviderKeyMembers("least-used-key", members);

    expect(first[0].connectionId).toBe("account-a");
    expect(second[0].connectionId).toBe("account-b");
  });

  it("pins account selection instead of falling through to another account", async () => {
    const first = await db.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "first",
      apiKey: "first-secret",
    });
    const second = await db.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "second",
      apiKey: "second-secret",
    });
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    expect((await getProviderCredentials(
      "claude",
      null,
      "test",
      { preferredConnectionId: second.id }
    )).connectionId).toBe(second.id);

    await db.updateProviderConnection(second.id, { isActive: false });
    expect(await getProviderCredentials(
      "claude",
      null,
      "test",
      { preferredConnectionId: second.id }
    )).toBeNull();
    expect(first.id).not.toBe(second.id);
  }, 10000);

  it("keeps scoped routing pinned and isolated after merging global key access and header overrides", async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const received = [];
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* consume the request */ }
      received.push(request.headers["x-api-key"]);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "msg_fixture", type: "message", role: "assistant", model: "test-model",
        content: [{ type: "text", text: "pinned account reply" }],
        stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 },
      }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const settings = await db.getSettings();
    try {
      const provider = "anthropic-compatible-merge-test";
      const providerSpecificData = { baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
      await db.createProviderConnection({
        provider, authType: "apikey", name: "unselected", apiKey: "wrong-account", providerSpecificData,
      });
      const pinned = await db.createProviderConnection({
        provider, authType: "apikey", name: "pinned", apiKey: "pinned-secret", providerSpecificData,
      });
      await db.upsertProviderKeyState("merge-check", "fill-first", [
        { model: `${provider}/test-model`, connectionId: pinned.id },
      ]);
      const issued = await db.createManualAccessToken("merge-check", ["merge-check"]);
      const globalKey = await db.createApiKey("restricted global", "test-machine");
      await db.updateApiKey(globalKey.id, { access: { restricted: true, allow: [] } });
      await db.updateSettings({
        requireApiKey: true,
        providerOverrides: { [provider]: { headers: { "x-api-key": "wrong-override" } } },
      });
      // Both authorization systems must survive the same backup/import cycle.
      await db.importDb(await db.exportDb());
      expect((await db.resolveAccessToken(issued.token)).allowedKeys).toEqual(["merge-check"]);
      expect((await db.getApiKeyById(globalKey.id)).access).toEqual({ restricted: true, allow: [] });

      const { POST } = await import("@/app/provider/v1/messages/route.js");
      const { handleChat } = await import("@/sse/handlers/chat.js");
      const request = (model, token = issued.token) => new Request("http://localhost/provider/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": token },
        body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
      });
      const success = await POST(request("merge-check"));
      expect(success.status).toBe(200);
      expect(await success.json()).toMatchObject({
        type: "message", model: "merge-check", content: [{ type: "text", text: "pinned account reply" }],
      });
      expect(received).toEqual(["pinned-secret"]);
      expect((await POST(request("vision-key"))).status).toBe(403);
      expect((await handleChat(request("merge-check", globalKey.key))).status).toBe(403);
      await db.updateProviderConnection(pinned.id, { isActive: false });
      expect((await POST(request("merge-check"))).status).toBe(503);
      await db.revokeAccessToken(issued.record.id);
      expect((await POST(request("merge-check"))).status).toBe(403);
      expect(received).toEqual(["pinned-secret"]);
    } finally {
      await db.updateSettings(settings);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15000);
});
