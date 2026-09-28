import { revokeAccessToken } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function DELETE(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  const { id } = await params;
  const revoked = await revokeAccessToken(id);
  return revoked
    ? new Response(null, { status: 204 })
    : Response.json({ error: "Unknown active access token" }, { status: 404 });
}
