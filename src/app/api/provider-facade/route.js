import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession.js";
import { listProviderKeys, putProviderKey, removeProviderKey } from "@/lib/aiproxy/providerKeys.js";
import { validateAllowedKeys } from "@/lib/aiproxy/accessControl.js";
import { getProviderConnections, setDefaultProviderKey } from "@/lib/db/index.js";
import { createManualAccessToken, getAccessTokens, revokeAccessToken } from "@/lib/db/repos/accessTokensRepo.js";
import { getProviderRequests } from "@/lib/db/repos/providerRequestsRepo.js";

export const dynamic = "force-dynamic";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorize(request) {
  // Management always needs a real dashboard login, even if upstream requireLogin is disabled.
  // Neither scoped inference credentials nor the lifecycle control token grant browser access.
  if (!await verifyDashboardAuthToken(request.cookies.get("auth_token")?.value)) {
    return json({ error: "Sign in to the AIProxy dashboard to manage scoped providers." }, 401);
  }
  // Next can normalize the internal URL to localhost. Use the actual Host, not
  // forwarded-host, so an authenticated loopback/tunnel browser retains its origin.
  const url = new URL(request.url);
  const origin = `${url.protocol}//${request.headers.get("host") || url.host}`;
  if (request.method !== "GET" && request.headers.get("origin") !== origin) {
    return json({ error: "Same-origin dashboard requests are required." }, 403);
  }
  return null;
}

export async function GET(request) {
  const denied = await authorize(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const [catalog, connections, tokens, requests] = await Promise.all([
    listProviderKeys(), getProviderConnections(), getAccessTokens(),
    getProviderRequests({ kind: query.get("kind"), externalSessionId: query.get("sessionId"), limit: query.get("limit") }),
  ]);
  // Explicit projection: upstream account objects contain secrets. Never spread them into UI data.
  const accounts = connections.map(({ id, name, provider, isActive, testStatus }) =>
    ({ id, name, provider, isActive, testStatus }));
  return json({ ...catalog, accounts, tokens, requests });
}

export async function POST(request) {
  const denied = await authorize(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    switch (body.action) {
      case "saveKey":
        return json(await putProviderKey(body.name, body));
      case "deleteKey":
        return await removeProviderKey(body.name)
          ? json({ deleted: true }) : json({ error: "Unknown provider key" }, 404);
      case "setDefault":
        return json({ defaultKey: await setDefaultProviderKey(body.name) });
      case "createToken": {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return json({ error: "Token name is required" }, 400);
        const allowedKeys = await validateAllowedKeys(body.allowedKeys);
        const issued = await createManualAccessToken(name, allowedKeys);
        return json({ ...issued.record, token: issued.token }, 201);
      }
      case "revokeToken":
        return await revokeAccessToken(body.id)
          ? json({ revoked: true }) : json({ error: "Unknown active token" }, 404);
      default:
        return json({ error: "Unknown scoped-provider action" }, 400);
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }
}
