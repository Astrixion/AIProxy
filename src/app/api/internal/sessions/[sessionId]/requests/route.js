import { getProviderRequestsForSession } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  const { sessionId } = await params;
  const limit = new URL(request.url).searchParams.get("limit");
  return Response.json({
    sessionId,
    requests: await getProviderRequestsForSession(sessionId, limit),
  });
}
