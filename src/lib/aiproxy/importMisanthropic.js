import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { stringifyJson } from "@/lib/db/helpers/jsonCol.js";

const PROVIDER_IDS = {
  "grok-build": "grok-cli",
};

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function providerId(value) {
  const source = required(value, "account.Provider");
  return PROVIDER_IDS[source] || source;
}

function connectionData(account) {
  const provider = providerId(account.Provider);
  const authType = account.AuthKind === "apikey" ? "apikey" : "oauth";
  const providerSpecificData = { authMethod: authType === "oauth" ? "misanthropic-import" : "apikey" };
  if (account.DeviceId) providerSpecificData.deviceId = account.DeviceId;
  if (account.WorkspaceId) providerSpecificData.chatgptAccountId = account.WorkspaceId;
  if (account.ProviderUserId) providerSpecificData.userId = account.ProviderUserId;
  if (account.AccountEmail) providerSpecificData.email = account.AccountEmail;
  if (account.BaseUrl) providerSpecificData.baseUrl = account.BaseUrl;

  return {
    provider,
    authType,
    name: required(account.Name, "account.Name"),
    email: account.AccountEmail || null,
    accessToken: authType === "oauth" ? required(account.AccessToken, `${account.Name}.AccessToken`) : undefined,
    refreshToken: account.RefreshToken || null,
    apiKey: authType === "apikey" ? required(account.AccessToken, `${account.Name}.AccessToken`) : undefined,
    expiresAt: account.ExpiresAtUtc || null,
    scope: account.Scope || null,
    tokenType: account.AuthHeader === "bearer" ? "Bearer" : null,
    providerSpecificData,
    testStatus: account.LastTestOk === true ? "active" : account.LastTestOk === false ? "error" : "unknown",
    lastTested: account.LastTestedAtUtc || null,
    lastError: account.LastTestError || null,
  };
}

export async function importMisanthropic(payload) {
  if (!Array.isArray(payload?.accounts) || !Array.isArray(payload?.routing?.Keys)
      || !Array.isArray(payload?.tokens)) {
    throw new Error("accounts, routing.Keys, and tokens are required");
  }

  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    const occupied = ["providerConnections", "providerKeyStates", "accessTokens", "revokedSessions"]
      .some((table) => (db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n || 0) > 0);
    const imported = db.get(
      `SELECT value FROM kv WHERE scope = 'aiproxy' AND key = 'misanthropicImportedAt'`
    );
    if (occupied || imported) {
      throw new Error("AIProxy provider state is not empty; refusing to overwrite it");
    }

    const connections = new Map();
    payload.accounts.forEach((account, index) => {
      const data = connectionData(account);
      const id = randomUUID();
      const { provider, authType, name, email, ...rest } = data;
      db.run(
        `INSERT INTO providerConnections(
           id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt
         ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [id, provider, authType, name, email, index + 1, stringifyJson(rest), now, now]
      );
      connections.set(name, { id, provider });
    });

    payload.routing.Keys.forEach((key) => {
      const name = required(key.Name, "routing key Name");
      const members = key.Members.map((member) => {
        if (member.AuthType !== "subscription") {
          throw new Error(`Provider key '${name}' has a non-account member; migrate it manually`);
        }
        const connection = connections.get(required(member.Subscription, `${name} member Subscription`));
        if (!connection) {
          throw new Error(`Provider key '${name}' references unknown account '${member.Subscription}'`);
        }
        return {
          connectionId: connection.id,
          model: `${connection.provider}/${required(member.Model, `${name} member Model`)}`,
        };
      });
      if (members.length === 0) throw new Error(`Provider key '${name}' has no members`);
      db.run(
        `INSERT INTO providerKeyStates(
           name, strategy, members, rotationIndex, usageCounts, createdAt, updatedAt
         ) VALUES(?, ?, ?, 0, '{}', ?, ?)`,
        [name, key.Rule || "round-robin", stringifyJson(members), now, now]
      );
    });

    if (payload.routing.DefaultKey) {
      const exists = db.get(`SELECT name FROM providerKeyStates WHERE name = ?`, [payload.routing.DefaultKey]);
      if (!exists) throw new Error(`Default provider key '${payload.routing.DefaultKey}' does not exist`);
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('aiproxy', 'defaultProviderKey', ?)`,
        [payload.routing.DefaultKey]
      );
    }

    const knownKeys = new Set(payload.routing.Keys.map((key) => key.Name));
    const legacySlots = new Map();
    payload.tokens.forEach((token) => {
      const externalSessionId = token.SessionId || null;
      const hash = required(token.TokenHash, "token.TokenHash").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("token.TokenHash must be a SHA-256 hash");
      if (!Array.isArray(token.AllowedKeys) || token.AllowedKeys.length === 0) {
        throw new Error("token.AllowedKeys must contain at least one provider key");
      }
      const unknownKey = token.AllowedKeys.find((key) => key !== "all" && !knownKeys.has(key));
      if (unknownKey) throw new Error(`Token references unknown provider key '${unknownKey}'`);
      let legacyIndex = null;
      if (externalSessionId) {
        legacyIndex = (legacySlots.get(externalSessionId) || 0) + 1;
        legacySlots.set(externalSessionId, legacyIndex);
      }
      db.run(
        `INSERT INTO accessTokens(
           id, tokenHash, name, kind, externalSessionId, slot, allowedKeys,
           isActive, createdAt, updatedAt
         ) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          randomUUID(),
          hash,
          token.Role || "misanthropic-import",
          externalSessionId ? "session" : "manual",
          externalSessionId,
          externalSessionId ? `legacy-${legacyIndex}` : null,
          stringifyJson(token.AllowedKeys || []),
          token.IssuedAt || now,
          now,
        ]
      );
    });

    db.run(
      `INSERT INTO kv(scope, key, value) VALUES('aiproxy', 'misanthropicImportedAt', ?)`,
      [now]
    );
    result = {
      accounts: payload.accounts.length,
      providerKeys: payload.routing.Keys.length,
      accessTokens: payload.tokens.length,
      defaultKey: payload.routing.DefaultKey || null,
    };
  });

  return result;
}
