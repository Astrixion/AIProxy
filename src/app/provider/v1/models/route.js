import { authenticateScopedRequest } from "@/lib/aiproxy/accessControl.js";
import { anthropicError, virtualModel } from "@/lib/aiproxy/anthropicFacade.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await authenticateScopedRequest(request);
  if (!auth.ok) return anthropicError(auth.status, "authentication_error", auth.error);
  const data = auth.credential.allowedKeys.map(virtualModel);
  return Response.json({
    data,
    has_more: false,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
  });
}
