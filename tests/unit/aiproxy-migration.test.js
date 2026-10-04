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
