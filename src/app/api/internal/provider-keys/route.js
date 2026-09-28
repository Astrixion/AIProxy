import { listProviderKeys } from "@/lib/aiproxy/providerKeys.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  return Response.json(await listProviderKeys());
}
