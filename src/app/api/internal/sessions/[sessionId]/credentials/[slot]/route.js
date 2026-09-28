import { upsertSessionAccessToken } from "@/lib/localDb";
import { validateAllowedKeys } from "@/lib/aiproxy/accessControl.js";
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
    const allowedKeys = await validateAllowedKeys(body.allowedKeys);
    const name = typeof body?.name === "string" && body.name.trim()
      ? body.name.trim()
      : `${sessionId}:${slot}`;
    const issued = await upsertSessionAccessToken({
      externalSessionId: sessionId,
      slot,
      name,
      allowedKeys,
    });
    return Response.json({ ...issued.record, token: issued.token });
  } catch (error) {
    const status = error.message?.startsWith("AIPROXY_SESSION_TOKEN_SECRET") ? 503 : 400;
    return Response.json({ error: error.message }, { status });
  }
}
