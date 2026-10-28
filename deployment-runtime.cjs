// Loaded before Next so every server bundle shares the same admission/work ledger.
const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn } = require("node:child_process");
const { createHash, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

module.exports = function createDeploymentRuntime() {
  const locks = new AsyncLocalStorage();
  const pending = new Map();
  const requests = new Map();
  let phase = "standby";
  let failure = null;
  let ready = null;
  const secret = process.env.AIPROXY_DEPLOYMENT_TOKEN;
  if (!secret || secret.length < 32) throw new Error("AIPROXY_DEPLOYMENT_TOKEN must contain at least 32 characters");
  for (const key of ["JWT_SECRET", "AIPROXY_CONTROL_TOKEN", "AIPROXY_SESSION_TOKEN_SECRET", "DATA_DIR", "AIPROXY_SLOT", "AIPROXY_RELEASE"]) {
    if (!process.env[key]) throw new Error(`Managed deployment requires ${key}`);
  }
  const lockDir = path.join(process.env.DATA_DIR, "deployment-locks");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });

  const runtime = {
    get phase() { return phase; },
    get failure() { return failure; },
    ownsBackground() {
      if (phase !== "active" || failure) return false;
      try {
        return fs.readFileSync("/app/deployment/active-slot", "utf8").trim() === process.env.AIPROXY_SLOT;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        runtime.fail("Cannot read background ownership");
        return false;
      }
    },
    fail(label) {
      failure = label;
      console.error(`[Deployment] ${label}; automatic drain completion is fenced`);
    },
    begin(label) {
      const id = Symbol(label);
      pending.set(id, label);
      return () => pending.delete(id);
    },
    track(label, fn) {
      const finish = runtime.begin(label);
      return Promise.resolve().then(fn).catch((error) => {
        runtime.fail(label);
        throw error;
      }).finally(finish);
    },
    async withLock(key, fn) {
      if (locks.getStore()?.has(key)) return fn();
      const name = createHash("sha256").update(key).digest("hex");
      // The lock lives on the shared volume. EOF releases it even if Node crashes;
      // there is no expiring lease that can authorize reuse of a rotating token.
      const child = spawn("flock", ["-x", path.join(lockDir, name), "sh", "-c", "printf 'locked\\n'; cat >/dev/null"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      let acquired = false;
      let releasing = false;
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.on("exit", () => {
        if (acquired && !releasing) {
          runtime.drain();
          runtime.fail("Cross-process lock lost");
        }
      });
      try {
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => reject(new Error("Cross-process lock helper exited")));
          child.stdout.once("data", () => { acquired = true; resolve(); });
        });
        const held = new Set(locks.getStore() || []);
        held.add(key);
        return await locks.run(held, fn);
      } finally {
        releasing = true;
        child.stdin.end();
        await exited;
      }
    },
    authenticated(req) {
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from(`Bearer ${secret}`);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    setReady(value) { ready = value; },
    status() {
      return {
        slot: process.env.AIPROXY_SLOT,
        release: process.env.AIPROXY_RELEASE,
        phase, ready: !!ready && !failure, compatibility: ready,
        requests: requests.size, activeRequests: [...requests.values()],
        pending: [...pending.values()], failure,
        drained: phase === "draining" && requests.size === 0 && pending.size === 0 && !failure,
      };
    },
    promote() {
      if (!ready || failure || phase !== "standby") throw new Error("Release is not ready standby");
      phase = "active";
    },
    drain() { phase = "draining"; },
    // Used only after a proven drain, including for a subsequent rollback.
    standby() {
      if (!runtime.status().drained) throw new Error("Release has not drained");
      phase = "standby";
    },
    async handle(req, res, handler, pathname) {
      if (phase !== "active") {
        res.writeHead(503, { "Content-Type": "application/json", "Connection": "close" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Release is not admitting requests" } }));
        return;
      }
      requests.set(req, { method: req.method, pathname, startedAt: new Date().toISOString() });
      const completed = new Promise((resolve) => {
        res.once("finish", resolve);
        res.once("close", resolve);
      });
      try {
        // These dashboard handlers can refresh or replace account credentials
        // directly. Serialize their entire read/refresh/write operation with
        // request-time refresh and the background owner, including GET probes.
        const accountOperation = /^\/api\/(providers|oauth)(\/|$)/.test(pathname)
          || /^\/api\/usage\/[a-f0-9-]{36}(\/|$)/i.test(pathname);
        if (accountOperation) {
          await runtime.withLock("credentials", async () => {
            runtime.assertCredentialState();
            await handler(req, res);
            await completed;
          });
        } else {
          await handler(req, res);
        }
        await completed;
      } catch (error) {
        runtime.fail("Request coordination failed");
        console.error("[Deployment] Request coordination failed:", error.message);
        if (!res.headersSent) res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request coordination unavailable; operator inspection required" }));
      } finally {
        requests.delete(req);
      }
    },
  };
  return runtime;
};
