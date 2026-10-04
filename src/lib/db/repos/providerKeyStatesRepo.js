import { randomInt } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const PROVIDER_KEY_STRATEGIES = [
  "round-robin",
  "fill-first",
  "random",
  "least-used",
];

const CONFIG_SCOPE = "aiproxy";
const DEFAULT_KEY = "defaultProviderKey";

function rowToState(row) {
  if (!row) return null;
  return {
    name: row.name,
    strategy: row.strategy,
    members: parseJson(row.members, []),
    rotationIndex: Number(row.rotationIndex) || 0,
    usageCounts: parseJson(row.usageCounts, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getProviderKeyState(name) {
  const db = await getAdapter();
  return rowToState(db.get(`SELECT * FROM providerKeyStates WHERE name = ?`, [name]));
}

export async function getProviderKeyStates() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM providerKeyStates ORDER BY createdAt ASC`).map(rowToState);
}

export async function getDefaultProviderKey() {
  const db = await getAdapter();
  return db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [CONFIG_SCOPE, DEFAULT_KEY])?.value || null;
}

export async function setDefaultProviderKey(name) {
  const db = await getAdapter();
  const normalized = typeof name === "string" ? name.trim() : "";
  if (!normalized) {
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [CONFIG_SCOPE, DEFAULT_KEY]);
    return null;
  }
  const exists = db.get(`SELECT name FROM providerKeyStates WHERE name = ?`, [normalized]);
  if (!exists) throw new Error(`Unknown provider key '${normalized}'`);
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [CONFIG_SCOPE, DEFAULT_KEY, normalized]
  );
  return normalized;
}

export async function upsertProviderKeyState(name, strategy = "fill-first", members = null) {
  if (!PROVIDER_KEY_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown provider key strategy '${strategy}'`);
  }
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = rowToState(db.get(`SELECT * FROM providerKeyStates WHERE name = ?`, [name]));
  const storedMembers = members ?? existing?.members ?? [];
  db.run(
    `INSERT INTO providerKeyStates(name, strategy, members, rotationIndex, usageCounts, createdAt, updatedAt)
     VALUES(?, ?, ?, 0, '{}', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       strategy = excluded.strategy,
       members = excluded.members,
       updatedAt = excluded.updatedAt`,
    [name, strategy, stringifyJson(storedMembers), now, now]
  );
  return getProviderKeyState(name);
}

export async function deleteProviderKeyState(name) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    result = db.run(`DELETE FROM providerKeyStates WHERE name = ?`, [name]);
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ? AND value = ?`, [CONFIG_SCOPE, DEFAULT_KEY, name]);
  });
  return (result?.changes ?? 0) > 0;
}

function memberIdentity(member) {
  return `${member.connectionId || ""}\u0000${member.model}`;
}

export async function selectProviderKeyMembers(name, members, defaultStrategy = "fill-first") {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error(`Provider key '${name}' has no members`);
  }
  const db = await getAdapter();
  let ordered = members;

  db.transaction(() => {
    const now = new Date().toISOString();
    let state = rowToState(db.get(`SELECT * FROM providerKeyStates WHERE name = ?`, [name]));
    if (!state) {
      state = {
        name,
        strategy: defaultStrategy,
        members,
        rotationIndex: 0,
        usageCounts: {},
        createdAt: now,
        updatedAt: now,
      };
    }
    if (!PROVIDER_KEY_STRATEGIES.includes(state.strategy)) {
      throw new Error(`Provider key '${name}' has an unknown strategy '${state.strategy}'`);
    }
    state.members = members;

    let selectedIndex = 0;
    if (state.strategy === "round-robin") {
      selectedIndex = state.rotationIndex >= 0 && state.rotationIndex < members.length
        ? state.rotationIndex
        : 0;
      state.rotationIndex = (selectedIndex + 1) % members.length;
    } else if (state.strategy === "random") {
      selectedIndex = randomInt(members.length);
    } else if (state.strategy === "least-used") {
      let lowest = Number.POSITIVE_INFINITY;
      members.forEach((member, index) => {
        const count = Number(state.usageCounts[memberIdentity(member)]) || 0;
        if (count < lowest) {
          lowest = count;
          selectedIndex = index;
        }
      });
    }

    ordered = [members[selectedIndex]];
    const selectedId = memberIdentity(ordered[0]);
    state.usageCounts[selectedId] = (Number(state.usageCounts[selectedId]) || 0) + 1;
    state.updatedAt = now;
    db.run(
      `INSERT INTO providerKeyStates(name, strategy, members, rotationIndex, usageCounts, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         strategy = excluded.strategy,
         members = excluded.members,
         rotationIndex = excluded.rotationIndex,
         usageCounts = excluded.usageCounts,
         updatedAt = excluded.updatedAt`,
      [
        state.name,
        state.strategy,
        stringifyJson(state.members),
        state.rotationIndex,
        stringifyJson(state.usageCounts),
        state.createdAt,
        state.updatedAt,
      ]
    );
  });

  return ordered;
}
