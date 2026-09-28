import { createHash, createHmac, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const TOKEN_PREFIX = "aip_sk_";

export function hashAccessToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function rowToAccessToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    externalSessionId: row.externalSessionId,
    slot: row.slot,
    allowedKeys: parseJson(row.allowedKeys, []),
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAccessTokens() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM accessTokens ORDER BY createdAt DESC`).map(rowToAccessToken);
}

export async function resolveAccessToken(token) {
  if (!token) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM accessTokens WHERE tokenHash = ? AND isActive = 1`,
    [hashAccessToken(token)]
  );
  return rowToAccessToken(row);
}

export async function validateAccessToken(token) {
  return !!(await resolveAccessToken(token));
}

export async function createManualAccessToken(name, allowedKeys) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const record = {
    id: uuidv4(),
    name,
    kind: "manual",
    externalSessionId: null,
    slot: null,
    allowedKeys: [...allowedKeys],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO accessTokens(
       id, tokenHash, name, kind, externalSessionId, slot, allowedKeys,
       isActive, createdAt, updatedAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      hashAccessToken(plaintext),
      record.name,
      record.kind,
      null,
      null,
      stringifyJson(record.allowedKeys),
      1,
      now,
      now,
    ]
  );
  return { token: plaintext, record };
}

function sessionPlaintext(externalSessionId, slot) {
  const secret = process.env.AIPROXY_SESSION_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AIPROXY_SESSION_TOKEN_SECRET must be set to at least 32 characters");
  }
  const digest = createHmac("sha256", secret)
    .update(JSON.stringify([externalSessionId, slot]), "utf8")
    .digest("base64url");
  return TOKEN_PREFIX + digest;
}

export async function upsertSessionAccessToken({ externalSessionId, slot, name, allowedKeys }) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const plaintext = sessionPlaintext(externalSessionId, slot);
  const tokenHash = hashAccessToken(plaintext);
  const existing = db.get(
    `SELECT * FROM accessTokens WHERE externalSessionId = ? AND slot = ?`,
    [externalSessionId, slot]
  );
  const id = existing?.id || uuidv4();
  const createdAt = existing?.createdAt || now;

  db.run(
    `INSERT INTO accessTokens(
       id, tokenHash, name, kind, externalSessionId, slot, allowedKeys,
       isActive, createdAt, updatedAt
     ) VALUES(?, ?, ?, 'session', ?, ?, ?, 1, ?, ?)
     ON CONFLICT(externalSessionId, slot) DO UPDATE SET
       tokenHash = excluded.tokenHash,
       name = excluded.name,
       allowedKeys = excluded.allowedKeys,
       isActive = 1,
       updatedAt = excluded.updatedAt`,
    [
      id,
      tokenHash,
      name,
      externalSessionId,
      slot,
      stringifyJson(allowedKeys),
      createdAt,
      now,
    ]
  );

  const row = db.get(
    `SELECT * FROM accessTokens WHERE externalSessionId = ? AND slot = ?`,
    [externalSessionId, slot]
  );
  return { token: plaintext, record: rowToAccessToken(row) };
}

export async function revokeAccessToken(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE accessTokens SET isActive = 0, updatedAt = ? WHERE id = ? AND isActive = 1`,
    [now, id]
  );
  return (result?.changes ?? 0) > 0;
}

export async function revokeSessionAccessTokens(externalSessionId) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE accessTokens SET isActive = 0, updatedAt = ?
     WHERE externalSessionId = ? AND isActive = 1`,
    [now, externalSessionId]
  );
  return result?.changes ?? 0;
}

export async function reconcileSessionAccessTokens(activeSessionIds) {
  const db = await getAdapter();
  const active = new Set(activeSessionIds);
  const rows = db.all(
    `SELECT DISTINCT externalSessionId FROM accessTokens
     WHERE kind = 'session' AND isActive = 1 AND externalSessionId IS NOT NULL`
  );
  const orphans = rows
    .map((row) => row.externalSessionId)
    .filter((sessionId) => !active.has(sessionId));
  if (orphans.length === 0) return [];

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const sessionId of orphans) {
      db.run(
        `UPDATE accessTokens SET isActive = 0, updatedAt = ?
         WHERE externalSessionId = ? AND isActive = 1`,
        [now, sessionId]
      );
    }
  });
  return orphans;
}
