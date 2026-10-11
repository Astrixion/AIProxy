import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalSessionSecret = process.env.AIPROXY_SESSION_TOKEN_SECRET;
let tempDir;
let db;
let adapter;
let importMisanthropic;
let repairRoute;
const originalControlToken = process.env.AIPROXY_CONTROL_TOKEN;

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function migrationPayload() {
  const legacySessionToken = "mis_sk_existing-session-token";
  const manualToken = "mis_sk_existing-manual-token";
  return {
    legacySessionToken,
    manualToken,
    payload: {
      accounts: [
        {
          Name: "grok-one",
          Provider: "grok-build",
          AuthKind: "oauth",
          AuthHeader: "bearer",
          AccessToken: "grok-access-token",
          RefreshToken: "grok-refresh-token",
          DeviceId: "grok-device",
          ProviderUserId: "grok-user",
        },
        {
          Name: "deepseek-one",
          Provider: "deepseek",
          AuthKind: "apikey",
          AuthHeader: "x-api-key",
          AccessToken: "deepseek-api-key",
        },
      ],
      routing: {
        DefaultKey: "build-key",
        Keys: [
          {
            Name: "build-key",
            Rule: "round-robin",
            Members: [
              { AuthType: "subscription", Subscription: "grok-one", Model: "grok-build" },
            ],
          },
          {
            Name: "static-key",
            Rule: "fill-first",
            Members: [
              { AuthType: "subscription", Subscription: "deepseek-one", Model: "deepseek-chat" },
            ],
          },
        ],
      },
      tokens: [
        {
          TokenHash: tokenHash(legacySessionToken).toUpperCase(),
          Role: "coordinator",
          SessionId: "session-cutover",
          AllowedKeys: ["build-key"],
          IssuedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          TokenHash: tokenHash(manualToken).toUpperCase(),
          Role: "overseer",
          SessionId: null,
          AllowedKeys: ["static-key"],
          IssuedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
  };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiproxy-migration-"));
  process.env.DATA_DIR = tempDir;
  process.env.AIPROXY_SESSION_TOKEN_SECRET = "test-session-secret-that-is-at-least-32-characters";
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  ({ getAdapter: adapter } = await import("@/lib/db/driver.js"));
  ({ importMisanthropic } = await import("@/lib/aiproxy/importMisanthropic.js"));
  ({ PATCH: repairRoute } = await import("@/app/api/internal/migrations/misanthropic/route.js"));
  process.env.AIPROXY_CONTROL_TOKEN = "test-control-token";
  await db.initDb();
  adapter = await adapter();
});

beforeEach(() => {
  adapter.transaction(() => {
    adapter.run(`DELETE FROM accessTokens`);
    adapter.run(`DELETE FROM revokedSessions`);
    adapter.run(`DELETE FROM providerKeyStates`);
    adapter.run(`DELETE FROM providerConnections`);
    adapter.run(`DELETE FROM kv WHERE scope = 'aiproxy'`);
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSessionSecret === undefined) delete process.env.AIPROXY_SESSION_TOKEN_SECRET;
  else process.env.AIPROXY_SESSION_TOKEN_SECRET = originalSessionSecret;
  if (originalControlToken === undefined) delete process.env.AIPROXY_CONTROL_TOKEN;
  else process.env.AIPROXY_CONTROL_TOKEN = originalControlToken;
});

describe("AIProxy default provider key", () => {
  it("clears with key deletion and survives database export and import", async () => {
    await db.upsertProviderKeyState("default-key", "round-robin", [
      { model: "claude/test", connectionId: "account-a" },
    ]);
    await db.setDefaultProviderKey("default-key");
    const snapshot = await db.exportDb();

    expect(snapshot.aiproxy).toEqual({ defaultProviderKey: "default-key" });
    await db.deleteProviderKeyState("default-key");
    expect(await db.getDefaultProviderKey()).toBeNull();

    await db.importDb(snapshot);
    expect(await db.getDefaultProviderKey()).toBe("default-key");
  });
});

describe("Misanthropic provider-state import", () => {
  it("maps accounts and keeps legacy credentials valid through deterministic reissue and revocation", async () => {
    const { payload, legacySessionToken, manualToken } = migrationPayload();

    await expect(importMisanthropic(payload)).resolves.toEqual({
      accounts: 2,
      providerKeys: 2,
      accessTokens: 2,
      defaultKey: "build-key",
    });

    const exported = await db.exportDb();
    expect(exported.providerConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "grok-one", provider: "grok-cli", authType: "oauth" }),
      expect.objectContaining({ name: "deepseek-one", provider: "deepseek", authType: "apikey" }),
    ]));
    expect(await db.getProviderKeyState("build-key")).toMatchObject({
      strategy: "round-robin",
      members: [expect.objectContaining({ model: "grok-cli/grok-build" })],
    });
    expect(await db.getDefaultProviderKey()).toBe("build-key");
    await expect(db.resolveAccessToken(legacySessionToken)).resolves.toMatchObject({
      externalSessionId: "session-cutover",
      slot: "legacy-1",
      allowedKeys: ["build-key"],
    });
    await expect(db.resolveAccessToken(manualToken)).resolves.toMatchObject({
      kind: "manual",
      externalSessionId: null,
      slot: null,
    });

    const primary = await db.upsertSessionAccessToken({
      externalSessionId: "session-cutover",
      slot: "primary",
      name: "coordinator",
      allowedKeys: ["build-key"],
    });
    expect(primary.record.slot).toBe("primary");
    expect(await db.resolveAccessToken(primary.token)).not.toBeNull();

    expect(await db.revokeSessionAccessTokens("session-cutover")).toBe(2);
    expect(await db.resolveAccessToken(legacySessionToken)).toBeNull();
    expect(await db.resolveAccessToken(primary.token)).toBeNull();
    expect(await db.resolveAccessToken(manualToken)).not.toBeNull();
  });

  it("refuses to overwrite existing AIProxy provider state", async () => {
    await db.upsertProviderKeyState("already-here", "fill-first", [
      { model: "claude/test", connectionId: "account-a" },
    ]);

    await expect(importMisanthropic(migrationPayload().payload))
      .rejects.toThrow("AIProxy provider state is not empty");
    expect(await db.getProviderKeyState("already-here")).not.toBeNull();
  });
});

function repairRequest(tokens, options = {}, authenticated = true) {
  return repairRoute(new Request("http://localhost/api/internal/migrations/misanthropic", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: "Bearer test-control-token" } : {}),
    },
    body: JSON.stringify({
      tokens,
      retainedSessionIds: ["session-cutover"],
      snapshotTakenAt: new Date().toISOString(),
      apply: true,
      ...options,
    }),
  }));
}

describe("Incomplete session-credential import repair", () => {
  it("previews without writes and restores only missing hashes idempotently, without rotating any credential", async () => {
    const { payload, legacySessionToken, manualToken } = migrationPayload();
    await importMisanthropic(payload);
    const before = await db.exportDb();
    const missingSecret = "retained-browser-credential";
    const missing = { ...payload.tokens[0], TokenHash: tokenHash(missingSecret), AllowedKeys: ["static-key"] };
    const tokens = [payload.tokens[0], missing];

    const preview = await repairRequest(tokens, { apply: false });
    expect(await preview.json()).toEqual({ applied: false, existing: 1, missing: 1, inserted: 0, unresolvedKeys: [] });
    expect(await db.resolveAccessToken(missingSecret)).toBeNull();
    const applied = await repairRequest(tokens);
    expect(await applied.json()).toEqual({ applied: true, existing: 1, missing: 1, inserted: 1, unresolvedKeys: [] });
    expect(await db.resolveAccessToken(missingSecret)).toMatchObject({
      kind: "session", externalSessionId: "session-cutover", slot: "legacy-2",
      allowedKeys: ["static-key"], createdAt: missing.IssuedAt,
    });
    expect(await db.resolveAccessToken(legacySessionToken)).toMatchObject({ slot: "legacy-1", allowedKeys: ["build-key"] });
    expect(await db.resolveAccessToken(manualToken)).toMatchObject({ kind: "manual", allowedKeys: ["static-key"] });
    const repeated = await repairRequest(tokens);
    expect(await repeated.json()).toEqual({ applied: true, existing: 2, missing: 0, inserted: 0, unresolvedKeys: [] });
    const after = await db.exportDb();
    expect(after.providerConnections).toEqual(before.providerConnections);
    expect(after.providerKeyStates).toEqual(before.providerKeyStates);
    expect(after.aiproxy).toEqual(before.aiproxy);
    await db.revokeSessionAccessTokens("session-cutover");
    expect(await db.resolveAccessToken(missingSecret)).toBeNull();
    expect((await repairRequest(tokens)).status).toBe(409);
    expect(await db.resolveAccessToken(missingSecret)).toBeNull();
  });

  it("preserves removed historical scopes without granting a replacement or restoring routing", async () => {
    const { payload } = migrationPayload();
    await importMisanthropic(payload);
    const secret = "retained-removed-model-credential";
    const missing = { ...payload.tokens[0], TokenHash: tokenHash(secret), AllowedKeys: ["retired-key"] };
    const preview = await repairRequest([missing], { apply: false });
    expect(await preview.json()).toMatchObject({ inserted: 0, unresolvedKeys: ["retired-key"] });
    const applied = await repairRequest([missing]);
    expect(await applied.json()).toMatchObject({ inserted: 1, unresolvedKeys: ["retired-key"] });
    expect(await db.resolveAccessToken(secret)).toMatchObject({ allowedKeys: ["retired-key"], slot: "legacy-2" });
    expect(await db.getProviderKeyState("retired-key")).toBeNull();
    const { validateAllowedKeys } = await import("@/lib/aiproxy/accessControl.js");
    await expect(validateAllowedKeys(["retired-key"])).rejects.toThrow("Unknown provider key");
    const { POST } = await import("@/app/provider/v1/messages/route.js");
    for (const [model, status] of [["retired-key", 404], ["build-key", 403]]) {
      const result = await POST(new Request("http://localhost/provider/v1/messages", {
        method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
      }));
      expect(result.status).toBe(status);
    }
  }, 20000);

  it.each(["manual", "unretained", "conflict", "stale", "future", "wildcard", "inactive"])(
    "rejects %s access atomically even after a valid missing credential in the batch", async (failure) => {
      const { payload } = migrationPayload();
      await importMisanthropic(payload);
      const missingSecret = "must-not-restore-partial-batch";
      const missing = { ...payload.tokens[0], TokenHash: tokenHash(missingSecret) };
      const invalid = { ...payload.tokens[0] };
      const options = {};
      if (failure === "manual") invalid.SessionId = null;
      if (failure === "unretained") invalid.SessionId = "not-retained";
      if (failure === "conflict") invalid.AllowedKeys = ["static-key"];
      if (failure === "stale") options.snapshotTakenAt = new Date(Date.now() - 301000).toISOString();
      if (failure === "future") invalid.IssuedAt = new Date(Date.now() + 60000).toISOString();
      if (failure === "wildcard") invalid.AllowedKeys = ["*"];
      if (failure === "inactive") adapter.run(`UPDATE accessTokens SET isActive = 0 WHERE kind = 'session'`);
      const response = await repairRequest([missing, invalid], options);
      expect(response.status).toBe(409);
      expect(await db.resolveAccessToken(missingSecret)).toBeNull();
    }
  );

  it("requires the control credential and an existing import", async () => {
    const { payload } = migrationPayload();
    expect((await repairRequest([payload.tokens[0]], {}, false)).status).toBe(401);
    expect((await repairRequest([payload.tokens[0]])).status).toBe(409);
    expect(await db.getAccessTokens()).toEqual([]);
  });
});
