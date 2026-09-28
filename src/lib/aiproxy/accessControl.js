import { getCombos, resolveAccessToken } from "@/lib/localDb";

export const RESERVED_ALL_KEY = "all";

function isLlmCombo(combo) {
  return !combo.kind || combo.kind === "llm";
}

export async function getProviderKeyNames() {
  const combos = (await getCombos()).filter(isLlmCombo);
  const names = combos.map((combo) => combo.name);
  if (combos.some((combo) => combo.models?.length > 0) && !names.includes(RESERVED_ALL_KEY)) {
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
  if (new Set(allowedKeys).size !== allowedKeys.length) {
    throw new Error("allowedKeys must be unique");
  }
  const known = new Set(await getProviderKeyNames());
  const unknown = allowedKeys.find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown provider key '${unknown}'`);
  return allowedKeys;
}

export async function resolveScopedCredential(presentedToken) {
  if (!presentedToken) return null;
  return resolveAccessToken(presentedToken);
}

export function credentialAllowsKey(credential, keyName) {
  return credential?.allowedKeys?.includes(keyName) === true;
}
