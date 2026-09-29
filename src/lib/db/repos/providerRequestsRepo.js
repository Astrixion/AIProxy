import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToRequest(row) {
  if (!row) return null;
  return {
    ...row,
    usage: row.usage ? parseJson(row.usage, null) : null,
  };
}

export async function startProviderRequest(record) {
  const db = await getAdapter();
  const request = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    externalSessionId: record.externalSessionId || null,
    tokenId: record.tokenId || null,
    slot: record.slot || null,
    virtualKey: record.virtualKey,
    provider: record.provider,
    upstreamModel: record.upstreamModel,
    connectionId: record.connectionId,
    status: "started",
    usage: null,
  };
  db.run(
    `INSERT INTO providerRequests(
       id, startedAt, completedAt, externalSessionId, tokenId, slot,
       virtualKey, provider, upstreamModel, connectionId, status, usage
     ) VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      request.id,
      request.startedAt,
      request.externalSessionId,
      request.tokenId,
      request.slot,
      request.virtualKey,
      request.provider,
      request.upstreamModel,
      request.connectionId,
      request.status,
    ]
  );
  return request;
}

export async function completeProviderRequest(id, { status, usage = null }) {
  const db = await getAdapter();
  const completedAt = new Date().toISOString();
  db.run(
    `UPDATE providerRequests
     SET completedAt = ?, status = ?, usage = ?
     WHERE id = ?`,
    [completedAt, status, usage ? stringifyJson(usage) : null, id]
  );
  return rowToRequest(db.get(`SELECT * FROM providerRequests WHERE id = ?`, [id]));
}

export async function getProviderRequestsForSession(externalSessionId, limit = 100) {
  const db = await getAdapter();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return db.all(
    `SELECT * FROM providerRequests
     WHERE externalSessionId = ?
     ORDER BY startedAt DESC
     LIMIT ?`,
    [externalSessionId, boundedLimit]
  ).map(rowToRequest);
}
