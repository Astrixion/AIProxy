import { authenticateScopedRequest, credentialAllowsKey } from "@/lib/aiproxy/accessControl.js";
import { anthropicError, virtualModel } from "@/lib/aiproxy/anthropicFacade.js";
import { getProviderKeyDescriptor } from "@/lib/aiproxy/providerKeys.js";

export async function GET(request, { params }) {
  const auth = await authenticateScopedRequest(request);
  if (!auth.ok) return anthropicError(auth.status, "authentication_error", auth.error);
  const { modelId } = await params;
  if (!credentialAllowsKey(auth.credential, modelId)) {
    return anthropicError(404, "not_found_error", `No model named '${modelId}'.`);
  }
  const canonicalKey = auth.credential.allowedKeys.find(
    (key) => key.toLowerCase() === modelId.toLowerCase()
  );
  if (!await getProviderKeyDescriptor(canonicalKey)) {
    return anthropicError(404, "not_found_error", `No model named '${modelId}'.`);
  }
  return Response.json(virtualModel(canonicalKey));
}
