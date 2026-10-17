// Run after `npm run build` at the repository root: node tests/ui/provider-facade.mjs
// Or verify a built release image: UI_DOCKER_IMAGE=astrixion/aiproxy:<commit> node tests/ui/provider-facade.mjs
// Uses an isolated standalone server and disposable data, never production credentials.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const serverPath = resolve(root, ".next/standalone/custom-server.js");
const image = process.env.UI_DOCKER_IMAGE;
assert.ok(image || existsSync(serverPath), "Build the app or set UI_DOCKER_IMAGE before running UI tests.");
const dir = mkdtempSync(resolve(tmpdir(), "aiproxy-ui-"));
const password = randomUUID();
const containerName = `aiproxy-ui-${randomUUID()}`;
const preload = resolve(dir, "bootstrap.cjs");
// The standalone bootstrap installs host-wide DNS/tunnel shutdown hooks, even
// with disposable HOME/DATA_DIR. Do not install those hooks in host-side tests.
writeFileSync(preload, "global.__appBootstrapped = true;\n");
const reservation = createServer();
await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
const port = reservation.address().port;
await new Promise((closed) => reservation.close(closed));
const base = `http://127.0.0.1:${port}`;
const server = spawn(image ? "docker" : process.execPath, image ? [
  "run", "--rm", "--pull=never", "--name", containerName,
  "--publish", `127.0.0.1:${port}:20128`,
  "--env", "INITIAL_PASSWORD", "--env", "JWT_SECRET",
  "--env", "DISABLE_BACKGROUND_TOKEN_REFRESH", "--env", "MODEL_CATALOG_SYNC", image,
] : ["--require", preload, serverPath], {
  cwd: image ? root : resolve(root, ".next/standalone"),
  env: {
    PATH: process.env.PATH, HOME: dir, DATA_DIR: resolve(dir, "data"),
    PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production",
    INITIAL_PASSWORD: password, JWT_SECRET: randomUUID(), NEXT_TELEMETRY_DISABLED: "1",
    DISABLE_BACKGROUND_TOKEN_REFRESH: "1", MODEL_CATALOG_SYNC: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
let browser;

async function capture(page, name) {
  if (!process.env.UI_SCREENSHOT_DIR) return;
  mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.UI_SCREENSHOT_DIR, `${name}.png`), animations: "disabled" });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    assert.equal(server.exitCode, null, `Isolated server exited: ${serverLog}`);
    try { ready = (await fetch(`${base}/api/auth/status`)).ok; } catch { /* Server is starting. */ }
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, `Server did not become ready: ${serverLog}`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1250 }, colorScheme: "dark" });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { password } });
  assert.equal(login.status(), 200, "Disposable dashboard login succeeds");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const keys = [{ name: "research", strategy: "round-robin", contextWindow: 200000, maxTokens: 8192,
    members: [{ connectionId: "account-a", model: "claude/sonnet" }] }];
  const tokens = Array.from({ length: 13 }, (_, i) => ({
    id: `token-${i}`, name: `Client ${String(i).padStart(2, "0")}`, allowedKeys: ["research"],
    kind: "manual", isActive: true, createdAt: "2026-10-11T00:00:00Z",
  }));
  tokens.push({ id: "session-token", name: "Room coordinator", allowedKeys: ["research"], kind: "session",
    externalSessionId: "room/session+42", slot: "primary", isActive: true, createdAt: "2026-10-11T01:00:00Z" });
  const requests = Array.from({ length: 13 }, (_, i) => ({
    id: `request-${i}`, startedAt: `2026-10-11T01:${String(i).padStart(2, "0")}:00Z`,
    completedAt: `2026-10-11T01:${String(i).padStart(2, "0")}:02Z`,
    virtualKey: i === 0 ? "zero-count" : i === 1 ? "partial-count" : "research",
    provider: "claude", connectionId: "account-a", upstreamModel: "claude/sonnet",
    tokenId: i === 0 ? "session-token" : "token-0", externalSessionId: i === 0 ? "room/session+42" : null,
    slot: i === 0 ? "primary" : null, status: i === 12 ? "http_429" : i === 1 ? "incomplete" : "complete",
    usage: i === 12 ? null : i === 0 ? { input: 0, output: null, cacheRead: 0, cacheWrite: null, complete: true }
      : i === 1 ? { input: 7, output: 3, cacheRead: null, cacheWrite: null, complete: false }
        : { input: 100, output: 10, cacheRead: null, cacheWrite: null, complete: true },
  }));
  let failStatus = 0;
  const fixtureRoute = async (route) => {
    if (failStatus) return route.fulfill({ status: failStatus, json: { error: "Fixture service unavailable" } });
    const params = new URL(route.request().url()).searchParams;
    let rows = requests;
    if (params.has("sessionId")) rows = rows.filter((row) => row.externalSessionId === params.get("sessionId"));
    else if (params.get("kind") === "session") rows = rows.filter((row) => row.externalSessionId);
    else if (params.get("kind") === "manual") rows = rows.filter((row) => !row.externalSessionId);
    return route.fulfill({ json: { keys, defaultKey: "research", reservedKey: { memberCount: 1 },
      accounts: [{ id: "account-a", name: "Research account", provider: "claude", isActive: true, testStatus: "active" }], tokens, requests: rows } });
  };
  await page.route("**/api/provider-facade?*", fixtureRoute);
  await page.goto(`${base}/dashboard`);
  const sidebarLink = (path) => page.locator(`nav a[href="${path}"]:visible`).first();
  const summary = page.getByRole("region", { name: "Loaded request summary" });
  const waitLoaded = (count) => page.getByText(new RegExp(`of ${count} matching · ${count} loaded`)).waitFor();
  await page.getByRole("heading", { name: "Loaded request summary · 13 matching attempts" }).waitFor();
  assert.equal(await sidebarLink("/dashboard").getAttribute("aria-current"), "page");
  assert.equal(await sidebarLink("/dashboard/endpoint").getAttribute("aria-current"), null);
  assert.equal(await page.getByRole("navigation", { name: "Scoped provider sections" }).count(), 0);
  assert.equal(await page.getByRole("table").count(), 0);
  assert.match(await summary.innerText(), /1,007/);
  assert.match(await summary.innerText(), /103/);
  assert.match(await summary.innerText(), /Reported in 12 of 13 attempts/);
  assert.match(await summary.innerText(), /Unknown/);
  await capture(page, "scoped-dashboard");
  await page.getByLabel("Session ID", { exact: true }).fill("room/session+42");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("heading", { name: "Loaded request summary · 1 matching attempts" }).waitFor();
  assert.deepEqual(await summary.locator("dl > div dd:first-of-type").allTextContents(), ["0", "Unknown", "0", "Unknown"]);
  await page.getByLabel("Session ID", { exact: true }).fill("missing-session");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("No recorded requests in this view.", { exact: true }).waitFor();
  assert.deepEqual(await summary.locator("dl > div dd:first-of-type").allTextContents(), ["Unknown", "Unknown", "Unknown", "Unknown"]);
  await capture(page, "scoped-dashboard-empty");
  await page.getByLabel("Request origin").selectOption("all");
  await page.getByRole("heading", { name: "Loaded request summary · 13 matching attempts" }).waitFor();
  failStatus = 503;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Displayed data may be stale.", { exact: true }).waitFor();
  assert.match(await summary.innerText(), /1,007/);
  await capture(page, "scoped-dashboard-stale");
  failStatus = 401;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Provider state is unavailable. Sign in and refresh to retry.", { exact: true }).waitFor();
  assert.equal(await summary.count(), 0);
  failStatus = 0;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Loaded request summary · 13 matching attempts" }).waitFor();
  await page.setViewportSize({ width: 390, height: 1600 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await capture(page, "scoped-dashboard-mobile");
  await page.getByRole("button", { name: "menu", exact: true }).click();
  await capture(page, "dashboard-mobile-sidebar");
  await sidebarLink("/dashboard/provider-facade").click();
  await page.waitForURL(`${base}/dashboard/provider-facade`);
  await page.getByRole("searchbox", { name: "Search provider keys" }).waitFor();
  await page.getByRole("button", { name: "menu", exact: true }).click();
  await sidebarLink("/dashboard").click();
  await page.waitForURL(`${base}/dashboard`);
  await page.setViewportSize({ width: 1440, height: 1250 });
  await sidebarLink("/dashboard/endpoint").click();
  await page.waitForURL(`${base}/dashboard/endpoint`);
  assert.equal(await sidebarLink("/dashboard/endpoint").getAttribute("aria-current"), "page");
  assert.equal(await sidebarLink("/dashboard").getAttribute("aria-current"), null);
  await page.getByRole("heading", { name: /API Endpoint$/ }).waitFor();
  await sidebarLink("/dashboard").click();
  await page.waitForURL(`${base}/dashboard`);
  await page.goBack();
  await page.waitForURL(`${base}/dashboard/endpoint`);
  await page.goForward();
  await page.waitForURL(`${base}/dashboard`);
  await page.getByRole("heading", { name: "Loaded request summary · 13 matching attempts" }).waitFor();
  await sidebarLink("/dashboard/provider-facade").click();
  await page.waitForURL(`${base}/dashboard/provider-facade`);
  assert.equal(await sidebarLink("/dashboard/provider-facade").getAttribute("aria-current"), "page");
  assert.equal(await sidebarLink("/dashboard").getAttribute("aria-current"), null);
  assert.equal(await page.getByRole("button", { name: "Dashboard", exact: true }).count(), 0);
  await page.getByRole("searchbox", { name: "Search provider keys" }).waitFor();
  await capture(page, "scoped-keys");
  await page.getByRole("searchbox", { name: "Search provider keys" }).fill("no-match");
  await page.getByText("No matching provider keys.").waitFor();
  await page.getByRole("searchbox", { name: "Search provider keys" }).fill("sonnet");
  await page.getByRole("heading", { name: /^research/ }).waitFor();

  await page.getByRole("button", { name: "Scoped tokens", exact: true }).click();
  const tokenTable = page.getByRole("table", { name: "scoped tokens" });
  assert.equal(await tokenTable.locator("tbody tr").count(), 10);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 2 of 2", { exact: true }).waitFor();
  assert.equal(await tokenTable.locator("tbody tr").count(), 3);
  await page.getByRole("searchbox", { name: "Search scoped tokens" }).fill("Client 01");
  await page.getByText("Page 1 of 1", { exact: true }).waitFor();
  assert.equal(await tokenTable.locator("tbody tr").count(), 1);
  assert.ok((await tokenTable.innerText()).includes("Client 01"));
  await page.getByRole("searchbox", { name: "Search scoped tokens" }).fill("");
  await page.getByRole("button", { name: "Credential" }).click();
  await page.getByRole("button", { name: "Credential" }).click();
  assert.ok((await tokenTable.locator("tbody tr").first().innerText()).includes("Client 12"));
  await capture(page, "scoped-tokens");

  await page.getByRole("button", { name: "Request history", exact: true }).click();
  await waitLoaded(13);
  assert.equal(await summary.count(), 0, "History does not embed the dashboard");
  await page.setViewportSize({ width: 1440, height: 1600 });
  await capture(page, "scoped-history");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Page 2 of 2", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Search request history" }).fill("zero-count");
  await page.getByText("1–1 of 1 matching · 13 loaded", { exact: true }).waitFor();
  await sidebarLink("/dashboard").click();
  await page.getByRole("heading", { name: "Loaded request summary · 13 matching attempts" }).waitFor();
  assert.match(await summary.innerText(), /13 matching attempts/, "Table search does not silently filter the dashboard");

  // Session IDs containing reserved URL characters round-trip and clearing does not send sessionId=.
  await sidebarLink("/dashboard/provider-facade").click();
  await page.getByRole("button", { name: "Scoped tokens", exact: true }).click();
  await page.getByLabel("Credential kind").selectOption("session");
  await page.getByRole("button", { name: "View history for session room/session+42", exact: true }).click();
  await waitLoaded(1);
  assert.equal(await page.getByLabel("Session ID", { exact: true }).inputValue(), "room/session+42");
  await page.getByLabel("Request origin").selectOption("manual");
  await waitLoaded(12);
  assert.equal(await page.getByRole("textbox", { name: "Session ID", exact: true }).inputValue(), "");
  await page.getByLabel("Request origin").selectOption("all");
  await waitLoaded(13);
  await page.getByRole("textbox", { name: "Session ID", exact: true }).fill("missing-session");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("No recorded requests in this view.", { exact: true }).waitFor();
  await capture(page, "scoped-empty");
  await page.getByRole("button", { name: "Clear session", exact: true }).click();
  await waitLoaded(1);
  await page.getByLabel("Request origin").selectOption("all");
  await waitLoaded(13);
  await page.setViewportSize({ width: 390, height: 1600 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await capture(page, "scoped-history-mobile");
  await page.setViewportSize({ width: 1440, height: 1600 });
  failStatus = 503;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Displayed data may be stale.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("table", { name: "request history" }).count(), 1);
  await capture(page, "scoped-stale");
  failStatus = 401;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Provider state is unavailable. Sign in and refresh to retry.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("table").count(), 0);
  assert.equal(await summary.count(), 0);

  // Exercise preserved writes on the real server, not the read-only fixtures.
  await page.unroute("**/api/provider-facade?*", fixtureRoute);
  const accountResponse = await context.request.post(`${base}/api/providers`, {
    data: { provider: "openai", name: "Disposable UI account", apiKey: "synthetic-never-used-upstream" },
  });
  assert.equal(accountResponse.status(), 201);
  await page.reload();
  await page.getByRole("button", { name: "Provider keys", exact: true }).click();
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.getByLabel("Key name", { exact: true }).fill("ui-test/key");
  await page.getByLabel("Account 1", { exact: true }).selectOption({ label: "Disposable UI account (openai)" });
  await page.getByLabel("Upstream model 1", { exact: true }).fill("openai/gpt-4o");
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  await page.getByText("Provider key saved.", { exact: true }).waitFor();
  await page.getByLabel("Default provider key", { exact: true }).selectOption("ui-test/key");
  await page.getByText("Default key saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Scoped tokens", exact: true }).click();
  await page.getByRole("button", { name: "Generate token", exact: true }).click();
  await page.getByLabel("Client name", { exact: true }).fill("Disposable UI client");
  await page.getByRole("checkbox", { name: "ui-test/key", exact: true }).check();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByLabel("New token secret", { exact: true }).waitFor();
  assert.match(await page.getByLabel("New token secret", { exact: true }).inputValue(), /^aip_sk_/);
  await page.getByRole("button", { name: "I have saved it", exact: true }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Credential revoked.", { exact: true }).waitFor();
  await page.getByRole("cell", { name: "Revoked", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Revoke", exact: true }).count(), 0);
  const persisted = await (await context.request.get(`${base}/api/provider-facade`)).json();
  assert.equal(persisted.defaultKey, "ui-test/key");
  assert.equal(persisted.tokens.length, 1);
  assert.equal(persisted.tokens[0].isActive, false);
  assert.ok(!JSON.stringify(persisted).includes("aip_sk_"));
  assert.deepEqual(errors, []);
  console.log("PASS: search, sorting, pagination, usage coverage/zeroes, session drill-down/clearing, empty/stale/unauthenticated states, mobile overflow, and real key/token mutations.");
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    if (image) execFileSync("docker", ["stop", "--time", "5", containerName], { stdio: "pipe" });
    else server.kill("SIGTERM");
  }
  await new Promise((resolveExit) => { if (server.exitCode !== null) resolveExit(); else server.once("exit", resolveExit); });
  rmSync(dir, { recursive: true, force: true });
}
