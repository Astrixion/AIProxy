import { getProviderKeyStates, resolveAccessToken } from "@/lib/localDb";

export const RESERVED_ALL_KEY = "all";

export async function getProviderKeyNames() {
  const states = (await getProviderKeyStates()).filter((state) => state.name !== RESERVED_ALL_KEY);
  const names = states.map((state) => state.name);
  if (states.some((state) => state.members?.length > 0) && !names.includes(RESERVED_ALL_KEY)) {
    names.push(RESERVED_ALL_KEY);
  }
  return names;
}

export async function validateAllowedKeys(value) {
  if (!Array.isArray(value)) throw new Error("allowedKeys must be an array");
  const allowedKeys = value.map((key) => typeof key === "string" ? key.trim() : "");
  if (allowedKeys.length === 0 || allowedKeys.some((key) => !key)) {
    throw new Error("allowedKeys must contain at least one non-empty provider key");
  }
  if (new Set(allowedKeys.map((key) => key.toLowerCase())).size !== allowedKeys.length) {
    throw new Error("allowedKeys must be unique");
  }
  const known = new Map((await getProviderKeyNames()).map((key) => [key.toLowerCase(), key]));
  const unknown = allowedKeys.find((key) => !known.has(key.toLowerCase()));
  if (unknown) throw new Error(`Unknown provider key '${unknown}'`);
  return allowedKeys.map((key) => known.get(key.toLowerCase()));
}

export async function resolveScopedCredential(presentedToken) {
  if (!presentedToken) return null;
  return resolveAccessToken(presentedToken);
}

export function credentialAllowsKey(credential, keyName) {
  const requested = String(keyName || "").toLowerCase();
  return credential?.allowedKeys?.some((key) => key.toLowerCase() === requested) === true;
}

export function extractScopedToken(request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.headers.get("x-api-key") || null;
}

export async function authenticateScopedRequest(request) {
  const token = extractScopedToken(request);
  if (!token) return { ok: false, status: 401, error: "Access token required" };
  const credential = await resolveAccessToken(token);
  return credential
    ? { ok: true, token, credential }
    : { ok: false, status: 403, error: "Invalid or revoked access token" };
}
