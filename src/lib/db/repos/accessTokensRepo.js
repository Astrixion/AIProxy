import { createHash, createHmac, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const TOKEN_PREFIX = "aip_sk_";
const RECONCILIATION_GRACE_MS = 5 * 60 * 1000;

export class SessionCredentialConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionCredentialConflictError";
    this.statusCode = 409;
  }
}

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
  let record;
  db.transaction(() => {
    const revoked = db.get(
      `SELECT externalSessionId FROM revokedSessions WHERE externalSessionId = ?`,
      [externalSessionId]
    );
    if (revoked) {
      throw new SessionCredentialConflictError(
        `Session '${externalSessionId}' was revoked and cannot receive credentials`
      );
    }

    const existing = db.get(
      `SELECT * FROM accessTokens WHERE externalSessionId = ? AND slot = ?`,
      [externalSessionId, slot]
    );
    if (existing) {
      const existingRecord = rowToAccessToken(existing);
      if (!existingRecord.isActive) {
        throw new SessionCredentialConflictError(
          `Credential '${externalSessionId}:${slot}' was revoked and cannot be reissued`
        );
      }
      const existingKeys = [...existingRecord.allowedKeys].sort();
      const requestedKeys = [...allowedKeys].sort();
      if (JSON.stringify(existingKeys) !== JSON.stringify(requestedKeys)) {
        throw new SessionCredentialConflictError(
          `Credential '${externalSessionId}:${slot}' already exists with a different scope`
        );
      }
      record = existingRecord;
      return;
    }

    const id = uuidv4();
    db.run(
      `INSERT INTO accessTokens(
         id, tokenHash, name, kind, externalSessionId, slot, allowedKeys,
         isActive, createdAt, updatedAt
       ) VALUES(?, ?, ?, 'session', ?, ?, ?, 1, ?, ?)`,
      [
        id,
        tokenHash,
        name,
        externalSessionId,
        slot,
        stringifyJson(allowedKeys),
        now,
        now,
      ]
    );

    record = rowToAccessToken(db.get(`SELECT * FROM accessTokens WHERE id = ?`, [id]));
  });
  return { token: plaintext, record };
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
  let revoked = 0;
  db.transaction(() => {
    db.run(
      `INSERT INTO revokedSessions(externalSessionId, revokedAt) VALUES(?, ?)
       ON CONFLICT(externalSessionId) DO NOTHING`,
      [externalSessionId, now]
    );
    const result = db.run(
      `UPDATE accessTokens SET isActive = 0, updatedAt = ?
       WHERE externalSessionId = ? AND isActive = 1`,
      [now, externalSessionId]
    );
    revoked = result?.changes ?? 0;
  });
  return revoked;
}

export async function reconcileSessionAccessTokens(retainedSessionIds, snapshotTakenAt) {
  const db = await getAdapter();
  const retained = new Set(retainedSessionIds);
  const snapshotMs = new Date(snapshotTakenAt).getTime();
  if (!Number.isFinite(snapshotMs)) throw new Error("snapshotTakenAt must be an ISO timestamp");
  const cutoff = new Date(snapshotMs - RECONCILIATION_GRACE_MS).toISOString();
  const rows = db.all(
    `SELECT DISTINCT externalSessionId FROM accessTokens
     WHERE kind = 'session' AND isActive = 1 AND externalSessionId IS NOT NULL
       AND createdAt <= ?`,
    [cutoff]
  );
  const orphans = rows
    .map((row) => row.externalSessionId)
    .filter((sessionId) => !retained.has(sessionId));
  if (orphans.length === 0) return [];

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const sessionId of orphans) {
      db.run(
        `INSERT INTO revokedSessions(externalSessionId, revokedAt) VALUES(?, ?)
         ON CONFLICT(externalSessionId) DO NOTHING`,
        [sessionId, now]
      );
      db.run(
        `UPDATE accessTokens SET isActive = 0, updatedAt = ?
         WHERE externalSessionId = ? AND isActive = 1`,
        [now, sessionId]
      );
    }
  });
  return orphans;
}
