// Built-in node:sqlite adapter — available in Node >= 22.5.0.
// No native build, no npm install. API mirrors betterSqliteAdapter.
import { PRAGMA_SQL } from "../schema.js";
import { existsSync } from "node:fs";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export async function createNodeSqliteAdapter(filePath) {
  // Suppress "ExperimentalWarning: SQLite is an experimental feature" from node:sqlite.
  // Stable enough for production use as of Node 22.x (RC quality).
  const origEmit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === "warning" && data?.name === "ExperimentalWarning" && /SQLite/i.test(data.message || "")) {
      return false;
    }
    return origEmit.call(process, name, data, ...rest);
  };

  // Dynamic import — fails on Node < 22.5 → driver.js falls back to sql.js
  const sqlite = await import("node:sqlite");
  const Database = sqlite.DatabaseSync;
  const managed = process.env.AIPROXY_DEPLOYMENT_MODE === "managed";
  if (managed && !existsSync(filePath)) throw new Error("Managed deployment requires an existing database");
  const db = new Database(filePath);

  if (managed) {
    if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal") {
      db.close();
      throw new Error("Managed deployment requires existing WAL mode");
    }
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  } else {
    db.exec(PRAGMA_SQL);
  }

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Periodic WAL checkpoint to keep -wal/-shm small
  const checkpointTimer = setInterval(() => {
    if (!managed) { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} }
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);
  if (!managed) {
    process.once("SIGINT", () => { onShutdown(); process.exit(0); });
    process.once("SIGTERM", () => { onShutdown(); process.exit(0); });
  }

  let transactionDepth = 0;

  return {
    driver: "node:sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec(sql) { return db.exec(sql); },
    transaction(fn) {
      // Acquire the write reservation before reading: deferred WAL transactions
      // cannot upgrade a stale read snapshot when the other release has written.
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      const outer = transactionDepth === 0;
      db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      transactionDepth++;
      try {
        const r = fn();
        db.exec(outer ? "COMMIT" : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        try {
          if (outer) db.exec("ROLLBACK");
          else { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); }
        } catch {}
        throw e;
      } finally {
        transactionDepth--;
      }
    },
    checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
