import { reconcileSessionAccessTokens } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function POST(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    if (!Array.isArray(body?.retainedSessionIds)) {
      return Response.json({ error: "retainedSessionIds must be an array" }, { status: 400 });
    }
    if (typeof body?.snapshotTakenAt !== "string") {
      return Response.json({ error: "snapshotTakenAt must be an ISO timestamp" }, { status: 400 });
    }
    const retainedSessionIds = body.retainedSessionIds.map((id) => String(id));
    const revokedSessionIds = await reconcileSessionAccessTokens(
      retainedSessionIds,
      body.snapshotTakenAt
    );
    return Response.json({ revokedSessionIds });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
