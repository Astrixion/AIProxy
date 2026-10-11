import { listProviderKeys, contextWindowForMembers, maxTokensForMembers } from "@/lib/aiproxy/providerKeys.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  const catalog = await listProviderKeys();
  const members = catalog.keys.flatMap(key => key.members);
  // Lifecycle discovery includes the derived selectable pool, not an editable key.
  if (members.length) catalog.keys.push({
    name: "all", strategy: "round-robin", members,
    contextWindow: contextWindowForMembers(members), maxTokens: maxTokensForMembers(members),
  });
  return Response.json(catalog);
}
