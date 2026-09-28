import { reconcileSessionAccessTokens } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function POST(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    if (!Array.isArray(body?.activeSessionIds)) {
      return Response.json({ error: "activeSessionIds must be an array" }, { status: 400 });
    }
    const activeSessionIds = body.activeSessionIds.map((id) => String(id));
    const revokedSessionIds = await reconcileSessionAccessTokens(activeSessionIds);
    return Response.json({ revokedSessionIds });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
