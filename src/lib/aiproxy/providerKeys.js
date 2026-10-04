import {
  deleteProviderKeyState,
  getProviderConnectionById,
  getProviderKeyState,
  getProviderKeyStates,
  PROVIDER_KEY_STRATEGIES,
  selectProviderKeyMembers,
  upsertProviderKeyState,
} from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { getModelInfo } from "@/sse/services/model.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
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

export async function getExactProviderKeyMembers(name) {
  if (name === RESERVED_ALL_KEY) {
    const members = (await getProviderKeyStates())
      .filter((state) => state.name !== RESERVED_ALL_KEY)
      .flatMap((state) => state.members);
    return members.length > 0
      ? selectProviderKeyMembers(RESERVED_ALL_KEY, members, "round-robin")
      : null;
  }

  const state = await getProviderKeyState(name);
  if (!state?.members?.every((member) => member.connectionId)) return null;
  return selectProviderKeyMembers(name, state.members);
}

export async function listProviderKeys() {
  const keys = (await getProviderKeyStates())
    .filter((state) => state.name !== RESERVED_ALL_KEY)
    .map((state) => ({
      name: state.name,
      members: state.members,
      strategy: state.strategy,
      contextWindow: contextWindowForMembers(state.members),
      maxTokens: maxTokensForMembers(state.members),
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

export function contextWindowForMembers(members) {
  if (!members?.length) return 128000;
  return Math.min(...members.map((member) => {
    const slash = member.model.indexOf("/");
    const provider = slash === -1 ? null : member.model.slice(0, slash);
    const model = slash === -1 ? member.model : member.model.slice(slash + 1);
    if (/^(gpt-5\.[56]|claude-(sonnet|opus)-4[.-]6|claude-opus-5[.-]5|k3$|kimi-k3$|deepseek-v4)/i.test(model)) {
      return 1000000;
    }
    if (/^(grok-build$|grok-4\.6)/i.test(model)) return 500000;
    const value = Number(getCapabilitiesForModel(provider, model)?.contextWindow);
    // 9Router's generic capability fallback is 200K. Misanthropic's contract
    // intentionally advertises an unknown member conservatively as 128K.
    return Number.isFinite(value) && value !== 200000 ? value : 128000;
  }));
}

export function maxTokensForMembers(members) {
  if (!members?.length) return 32768;
  return Math.min(...members.map((member) => {
    const slash = member.model.indexOf("/");
    const provider = slash === -1 ? null : member.model.slice(0, slash);
    const model = slash === -1 ? member.model : member.model.slice(slash + 1);
    if (/^claude-opus-5[.-]5/i.test(model)) return 128000;
    const value = Number(getCapabilitiesForModel(provider, model)?.maxOutput);
    return Number.isFinite(value) ? Math.min(value, 32768) : 32768;
  }));
}

export async function getProviderKeyDescriptor(name) {
  if (name === RESERVED_ALL_KEY) {
    const states = (await getProviderKeyStates()).filter((state) => state.name !== RESERVED_ALL_KEY);
    const members = states.flatMap((state) => state.members);
    return members.length ? {
      name,
      members,
      strategy: "round-robin",
      contextWindow: contextWindowForMembers(members),
      maxTokens: maxTokensForMembers(members),
    } : null;
  }
  const state = await getProviderKeyState(name);
  return state ? {
    ...state,
    contextWindow: contextWindowForMembers(state.members),
    maxTokens: maxTokensForMembers(state.members),
  } : null;
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
  const strategy = body.strategy || "round-robin";
  if (!PROVIDER_KEY_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown provider key strategy '${strategy}'`);
  }
  const collision = (await getProviderKeyStates()).find(
    (state) => state.name.toLowerCase() === name.toLowerCase() && state.name !== name
  );
  if (collision) throw new Error(`Provider key '${collision.name}' already uses that name`);
  const state = await upsertProviderKeyState(name, strategy, members);
  return {
    name: state.name,
    members: state.members,
    strategy: state.strategy,
    contextWindow: contextWindowForMembers(state.members),
    maxTokens: maxTokensForMembers(state.members),
  };
}

export async function removeProviderKey(name) {
  return deleteProviderKeyState(name);
}
