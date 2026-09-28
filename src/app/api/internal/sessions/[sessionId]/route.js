import { revokeSessionAccessTokens } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function DELETE(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  const { sessionId } = await params;
  const revoked = await revokeSessionAccessTokens(sessionId);
  return Response.json({ sessionId, revoked });
}
