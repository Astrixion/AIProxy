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
});
