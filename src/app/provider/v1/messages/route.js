import { handleChat } from "@/sse/handlers/chat.js";
import {
  anthropicError,
  normalizeFacadeResponse,
  validateMessagesRequest,
} from "@/lib/aiproxy/anthropicFacade.js";
import {
  authenticateScopedRequest,
  credentialAllowsKey,
} from "@/lib/aiproxy/accessControl.js";
import { getProviderKeyDescriptor } from "@/lib/aiproxy/providerKeys.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function POST(request) {
  const auth = await authenticateScopedRequest(request);
  if (!auth.ok) return anthropicError(auth.status, "authentication_error", auth.error);

  let body;
  try {
    body = await request.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "Messages requests must contain a JSON object body.");
  }
  const validationError = validateMessagesRequest(body);
  if (validationError) return anthropicError(400, "invalid_request_error", validationError);

  const requestedKey = body.model.trim();
  if (!credentialAllowsKey(auth.credential, requestedKey)) {
    return anthropicError(403, "permission_error", "This token does not allow the requested virtual model.");
  }
  const canonicalKey = auth.credential.allowedKeys.find(
    (key) => key.toLowerCase() === requestedKey.toLowerCase()
  );
  if (!await getProviderKeyDescriptor(canonicalKey)) {
    return anthropicError(404, "not_found_error", `No model named '${requestedKey}'.`);
  }

  await ensureInitialized();
  const normalizedBody = { ...body, model: canonicalKey, stream: body.stream === true };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const internalRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(normalizedBody),
  });
  const response = await handleChat(internalRequest, null, {
    body: normalizedBody,
    scopedCredential: auth.credential,
  });
  return normalizeFacadeResponse(response, canonicalKey, normalizedBody.stream);
}
