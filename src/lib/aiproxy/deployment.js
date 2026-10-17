import { createHash, createHmac } from "node:crypto";
import { getAdapter } from "@/lib/db/driver.js";
import { assertCompatibleSchema } from "@/lib/db/migrate.js";
import { TABLES, SCHEMA_VERSION } from "@/lib/db/schema.js";
import { latestVersion } from "@/lib/db/migrations/index.js";
import { getSettings, assertManagedSettings } from "@/lib/db/repos/settingsRepo.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { mergeRefreshedCredentials } from "open-sse/services/oauthCredentialManager.js";
import { deploymentRuntime } from "open-sse/services/deployment.js";
import { initTranslators } from "open-sse/translator/index.js";
import { startBackgroundTokenRefresh } from "@/sse/services/backgroundTokenRefresh.js";

export async function prepareDeployment() {
  const runtime = deploymentRuntime();
  if (!runtime) throw new Error("Managed custom server is required");
  if (runtime.phase !== "standby") throw new Error("Readiness requires standby");
  runtime.setReady(null);
  const db = await getAdapter();
  assertCompatibleSchema(db);
  assertManagedSettings(await getSettings());
  for (const key of ["JWT_SECRET", "AIPROXY_CONTROL_TOKEN", "AIPROXY_SESSION_TOKEN_SECRET"]) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  await initTranslators();
  await runtime.withLock("readiness", async () => {});
  runtime.assertCredentialState = () => {
    if (db.get("SELECT key FROM _meta WHERE key LIKE 'credentialRefreshInFlight:%' LIMIT 1")) {
      throw new Error("Uncertain OAuth refresh; reconcile credentials before deployment or account administration");
    }
  };
  await runtime.withLock("credentials", runtime.assertCredentialState);

  // Sync translators must see signatures committed by either release, not just
  // the replacement's initially empty memory cache.
  runtime.readThoughtSignature = (key) => {
    const row = db.get("SELECT value FROM kv WHERE scope = ? AND key = ?", ["gemini_thought_signatures", key]);
    return row ? JSON.parse(row.value) : null;
  };

  runtime.refreshCredentials = (provider, snapshot, refresh) => runtime.track("credential refresh", () =>
    runtime.withLock("credentials", async () => {
      const id = snapshot.connectionId || snapshot.id;
      if (!id) throw new Error("Managed refresh requires a durable connection id");
      const latest = await getProviderConnectionById(id);
      if (!latest || !latest.isActive) throw new Error("Credential connection is unavailable");
      const intent = `credentialRefreshInFlight:${id}`;
      if (db.get("SELECT key FROM _meta WHERE key = ?", [intent])) {
        throw new Error("Uncertain previous OAuth refresh; operator reconciliation required");
      }
      // A different process already rotated this snapshot. Use its committed pair;
      // never contact the provider using the old refresh token.
      if (latest.refreshToken !== snapshot.refreshToken || latest.accessToken !== snapshot.accessToken
          || latest.apiKey !== snapshot.apiKey) {
        return { ...latest, connectionId: id };
      }
      const current = {
        ...snapshot, ...latest, connectionId: id,
        providerSpecificData: { ...snapshot.providerSpecificData, ...latest.providerSpecificData },
      };
      // Persist intent before consuming a possibly single-use token. A crash or
      // ambiguous upstream failure must not allow another process to reuse it.
      db.run("INSERT INTO _meta(key, value) VALUES(?, ?)", [intent, new Date().toISOString()]);
      const refreshed = await refresh(current);
      if (!refreshed?.accessToken && !refreshed?.apiKey && !refreshed?.copilotToken) {
        throw new Error("OAuth refresh outcome is uncertain; operator reconciliation required");
      }
      const merged = mergeRefreshedCredentials(provider, current, refreshed);
      if (merged.copilotToken || merged.copilotTokenExpiresAt) {
        merged.providerSpecificData = {
          ...current.providerSpecificData, ...merged.providerSpecificData,
          ...(merged.copilotToken ? { copilotToken: merged.copilotToken } : {}),
          ...(merged.copilotTokenExpiresAt ? { copilotTokenExpiresAt: merged.copilotTokenExpiresAt } : {}),
        };
      }
      if (!await updateProviderConnection(id, merged, { completeRefresh: true })) throw new Error("Refreshed credential could not be persisted");
      return { ...current, ...merged };
    })
  );
  // Increment protocol when persistence/credential semantics cease to overlap safely.
  const compatibility = {
    protocol: 1,
    schema: createHash("sha256").update(JSON.stringify([SCHEMA_VERSION, latestVersion(), TABLES])).digest("hex"),
    identity: createHmac("sha256", process.env.AIPROXY_DEPLOYMENT_TOKEN)
      .update(JSON.stringify([process.env.JWT_SECRET, process.env.AIPROXY_CONTROL_TOKEN, process.env.AIPROXY_SESSION_TOKEN_SECRET]))
      .digest("hex"),
    driver: db.driver,
  };
  runtime.setReady(compatibility);
  startBackgroundTokenRefresh();
  return runtime.status();
}
