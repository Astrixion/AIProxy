import {
  createCombo,
  deleteCombo,
  deleteProviderKeyState,
  getComboByName,
  getCombos,
  getProviderConnectionById,
  getProviderKeyState,
  PROVIDER_KEY_STRATEGIES,
  selectProviderKeyMembers,
  updateCombo,
  upsertProviderKeyState,
} from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { getModelInfo } from "@/sse/services/model.js";
import { RESERVED_ALL_KEY } from "./accessControl.js";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export function normalizeProviderKeyMember(member) {
  if (typeof member === "string") {
    return member.trim() ? { model: member.trim(), connectionId: null } : null;
  }
  if (!member || typeof member !== "object") return null;
  const model = typeof member.model === "string" ? member.model.trim() : "";
  const connectionId = typeof member.connectionId === "string" ? member.connectionId.trim() : "";
  return model ? { model, connectionId: connectionId || null } : null;
}

function isLlmCombo(combo) {
  return !combo.kind || combo.kind === "llm";
}

function comboMembers(combo) {
  return (combo?.models || []).map(normalizeProviderKeyMember).filter(Boolean);
}

export async function getExactProviderKeyMembers(name) {
  if (name === RESERVED_ALL_KEY) {
    const combos = (await getCombos()).filter(
      (combo) => combo.name !== RESERVED_ALL_KEY && isLlmCombo(combo)
    );
    const members = (await Promise.all(combos.map(async (combo) => {
      const state = await getProviderKeyState(combo.name);
      return state?.members?.length > 0 ? state.members : comboMembers(combo);
    }))).flat();
    return members.length > 0
      ? selectProviderKeyMembers(RESERVED_ALL_KEY, members, "round-robin")
      : null;
  }

  const combo = await getComboByName(name);
  if (!combo || !isLlmCombo(combo)) return null;
  const state = await getProviderKeyState(name);
  if (!state?.members?.some((member) => member.connectionId)) return null;
  return selectProviderKeyMembers(name, state.members);
}

export async function listProviderKeys() {
  const combos = (await getCombos()).filter(isLlmCombo);
  const keys = await Promise.all(combos.map(async (combo) => {
    const state = await getProviderKeyState(combo.name);
    return {
      name: combo.name,
      members: state?.members?.length > 0 ? state.members : comboMembers(combo),
      strategy: state?.strategy || "fill-first",
    };
  }));
  return {
    keys,
    reservedKey: {
      name: RESERVED_ALL_KEY,
      memberCount: keys.reduce((total, key) => total + key.members.length, 0),
      strategy: "round-robin",
    },
  };
}

export async function validateProviderKeyInput(name, body) {
  if (!name || !VALID_NAME_REGEX.test(name)) {
    throw new Error("Provider key name can only contain letters, numbers, -, _ and .");
  }
  if (name === RESERVED_ALL_KEY) {
    throw new Error(`'${RESERVED_ALL_KEY}' is reserved`);
  }
  if (!Array.isArray(body?.members) || body.members.length === 0) {
    throw new Error("members must contain at least one account and model");
  }

  const members = [];
  const identities = new Set();
  for (const raw of body.members) {
    const member = normalizeProviderKeyMember(raw);
    if (!member?.connectionId) {
      throw new Error("Every member must include model and connectionId");
    }
    if (!member.model.includes("/")) {
      throw new Error(`Model '${member.model}' must use provider/model format`);
    }
    const connection = await getProviderConnectionById(member.connectionId);
    if (!connection) throw new Error(`Unknown provider connection '${member.connectionId}'`);
    const modelInfo = await getModelInfo(member.model);
    if (!modelInfo.provider) throw new Error(`Model '${member.model}' must name a provider`);
    if (resolveProviderId(modelInfo.provider) !== resolveProviderId(connection.provider)) {
      throw new Error(
        `Connection '${member.connectionId}' belongs to '${connection.provider}', not '${modelInfo.provider}'`
      );
    }
    const identity = `${member.connectionId}\u0000${member.model}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate member '${member.model}' on connection '${member.connectionId}'`);
    }
    identities.add(identity);
    members.push(member);
  }
  return members;
}

export async function putProviderKey(name, body) {
  const members = await validateProviderKeyInput(name, body);
  const strategy = body.strategy || "fill-first";
  if (!PROVIDER_KEY_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown provider key strategy '${strategy}'`);
  }
  const existing = await getComboByName(name);
  const combo = existing
    ? await updateCombo(existing.id, { name, kind: "llm", models: members.map((member) => member.model) })
    : await createCombo({ name, kind: "llm", models: members.map((member) => member.model) });
  const state = await upsertProviderKeyState(name, strategy, members);
  return { name: combo.name, members: state.members, strategy: state.strategy };
}

export async function removeProviderKey(name) {
  const combo = await getComboByName(name);
  if (!combo) return false;
  await deleteCombo(combo.id);
  await deleteProviderKeyState(name);
  return true;
}
