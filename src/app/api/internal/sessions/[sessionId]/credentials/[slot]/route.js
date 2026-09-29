import { upsertSessionAccessToken } from "@/lib/localDb";
import { validateAllowedKeys } from "@/lib/aiproxy/accessControl.js";
import { getProviderKeyDescriptor } from "@/lib/aiproxy/providerKeys.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

const SESSION_SLOTS = new Set(["primary", "browser-vision"]);

export async function PUT(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const { sessionId, slot } = await params;
    if (!sessionId?.trim()) {
      return Response.json({ error: "sessionId is required" }, { status: 400 });
    }
    if (!SESSION_SLOTS.has(slot)) {
      return Response.json(
        { error: "slot must be 'primary' or 'browser-vision'" },
        { status: 400 }
      );
    }
    const body = await request.json();
    const keyName = typeof body?.keyName === "string" ? body.keyName.trim() : "";
    if (!keyName) {
      return Response.json({ error: "keyName is required" }, { status: 400 });
    }
    const [canonicalKey] = await validateAllowedKeys([keyName]);
    const descriptor = await getProviderKeyDescriptor(canonicalKey);
    if (!descriptor) {
      return Response.json({ error: `Unknown provider key '${canonicalKey}'` }, { status: 404 });
    }
    const name = typeof body?.name === "string" && body.name.trim()
      ? body.name.trim()
      : `${sessionId}:${slot}`;
    const issued = await upsertSessionAccessToken({
      externalSessionId: sessionId,
      slot,
      name,
      allowedKeys: [canonicalKey],
    });
    const configuredBaseUrl = process.env.AIPROXY_PROVIDER_BASE_URL?.replace(/\/$/, "");
    const baseUrl = configuredBaseUrl || `${new URL(request.url).origin}/provider`;
    return Response.json({
      ...issued.record,
      credential: {
        baseUrl,
        model: canonicalKey,
        token: issued.token,
        contextWindow: descriptor.contextWindow,
      },
    });
  } catch (error) {
    const status = error.statusCode
      || (error.message?.startsWith("Unknown provider key") ? 404 : null)
      || (error.message?.startsWith("AIPROXY_SESSION_TOKEN_SECRET") ? 503 : 400);
    return Response.json({ error: error.message }, { status });
  }
}
