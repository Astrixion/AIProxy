"use client";

import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Button, Card, Input, Modal, ConfirmModal } from "@/shared/components";
import Dashboard from "./Dashboard";
import RequestHistory from "./RequestHistory";
import ScopedTokens from "./ScopedTokens";

const strategies = ["round-robin", "fill-first", "random", "least-used"];
const blankMember = () => ({ connectionId: "", model: "" });

function SelectField({ label, children, ...props }) {
  return <label className="flex flex-col gap-1.5 text-sm font-medium text-text-main">
    {label}
    <select aria-label={label} className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 text-text-main focus:outline-2 focus:outline-primary min-w-0" {...props}>{children}</select>
  </label>;
}

async function api(body, query = "", signal) {
  const response = await fetch(`/api/provider-facade${query}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function ProviderManagement({ overview = false }) {
  // Scope private cached data to this page, never persist it across browser sessions.
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  }));
  return <QueryClientProvider client={client}><ProviderManagementContent overview={overview} /></QueryClientProvider>;
}

function ProviderManagementContent({ overview }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("keys");
  const [kind, setKind] = useState("all");
  const [sessionInput, setSessionInput] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [tokenKind, setTokenKind] = useState("manual");
  const [keySearch, setKeySearch] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(null);
  const [tokenForm, setTokenForm] = useState(null);
  const [issued, setIssued] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const query = useQuery({
    queryKey: ["scoped-providers", kind, sessionId],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ kind, limit: "200" });
      // An empty session parameter means no results in the API, not all sessions.
      if (sessionId) params.set("sessionId", sessionId);
      return api(null, `?${params}`, signal);
    },
  });
  const mutation = useMutation({
    mutationFn: async ({ body, done }) => {
      const result = await api(body);
      done(result);
      // Never return one-time credential secrets into TanStack's mutation cache.
    },
    onMutate: () => setNotice(""),
    onSuccess: async (_, { message }) => {
      setNotice(message);
      await queryClient.invalidateQueries({ queryKey: ["scoped-providers"] });
    },
  });
  const data = query.error?.status === 401 ? null : query.data;
  const error = mutation.error?.message || query.error?.message;
  const busy = mutation.isPending;
  const loading = query.isFetching;
  const load = () => { mutation.reset(); query.refetch(); };

  function mutate(body, message, done = () => {}) {
    mutation.mutate({ body, message, done });
  }

  function showSessionHistory(id) {
    setSessionInput(id);
    setSessionId(id);
    setKind("session");
    setTab("history");
  }

  function updateMember(index, patch) {
    setEditor((current) => ({ ...current, members: current.members.map((member, i) => i === index ? { ...member, ...patch } : member) }));
  }

  const accounts = useMemo(() => new Map(data?.accounts.map((account) => [account.id, account]) || []), [data?.accounts]);
  const tokens = useMemo(() => data?.tokens.filter((token) => tokenKind === "all" || token.kind === tokenKind) || [], [data?.tokens, tokenKind]);
  const keys = data?.keys.filter((key) => [key.name, key.strategy, ...key.members.flatMap((member) => [member.model, accounts.get(member.connectionId)?.name])]
    .join(" ").toLowerCase().includes(keySearch.trim().toLowerCase())) || [];
  const names = [...(data?.keys.map((key) => key.name) || []), ...(data?.reservedKey.memberCount ? ["all"] : [])];
  const closeEditor = () => { if (!busy) setEditor(null); };
  const closeTokenForm = () => { if (!busy) setTokenForm(null); };

  return <div className="min-w-0 space-y-6 max-w-6xl mx-auto pb-8">
    <header className="flex flex-wrap justify-between items-start gap-4">
      <div className="space-y-2 max-w-2xl">
        <h1 className="text-2xl font-semibold text-text-main">{overview ? "Dashboard" : "Scoped providers"}</h1>
        {overview ? <p className="text-sm text-text-muted">Request outcomes and reported usage for scoped provider traffic. Manage keys, tokens and request history in <Link className="underline text-primary" href="/dashboard/provider-facade">Scoped providers</Link>.</p>
          : <p className="text-sm text-text-muted">Exact-account pools and credentials for Misanthropic, Sonar and other Messages clients. Account logins stay in <Link className="underline text-primary" href="/dashboard/providers">Providers</Link>.</p>}
      </div>
      <Button variant="secondary" onClick={load} disabled={busy} loading={loading}>Refresh</Button>
    </header>

    {error && <div role="alert" className="rounded-[10px] border border-red-500/30 bg-red-500/10 p-4 text-sm text-text-main">
      {error} {data && <span>Displayed data may be stale.</span>}
    </div>}
    {notice && <p role="status" className="text-sm text-text-main">{notice}</p>}
    {!overview && <nav aria-label="Scoped provider sections" className="flex flex-wrap gap-2 border-b border-border pb-3">
      {[["keys", "Provider keys"], ["tokens", "Scoped tokens"], ["history", "Request history"]].map(([value, label]) =>
        <Button key={value} variant={tab === value ? "primary" : "ghost"} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</Button>)}
    </nav>}
    {(overview || tab === "history") && <form className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end" onSubmit={(event) => {
      event.preventDefault();
      setSessionId(sessionInput.trim());
      if (sessionInput.trim()) setKind("session");
    }}>
      <SelectField label="Request origin" value={kind} onChange={(event) => {
        setKind(event.target.value); setSessionId(""); setSessionInput("");
      }}>
        <option value="all">All requests</option><option value="manual">Manual clients</option><option value="session">Sessions</option>
      </SelectField>
      <Input className="min-w-0 flex-1 sm:min-w-64" label="Session ID" aria-label="Session ID" placeholder="Exact session ID (optional)"
        value={sessionInput} onChange={(event) => setSessionInput(event.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary">Apply</Button>
        {sessionId && <Button type="button" variant="ghost" onClick={() => { setSessionInput(""); setSessionId(""); }}>Clear session</Button>}
      </div>
      <p className="w-full break-words text-xs text-text-muted">{sessionId ? `Applied session: ${sessionId}` : "No session filter applied."} Changing origin clears the session filter.</p>
    </form>}
    {!data && <p className="text-text-muted">{loading ? "Loading provider state…" : "Provider state is unavailable. Sign in and refresh to retry."}</p>}

    {data && overview && <Card>
      <Dashboard requests={data.requests} />
    </Card>}

    {data && !overview && tab === "keys" && <>
      <Card title="Default key" subtitle="Used when a lifecycle caller omits its key. Inference requests must still name a model.">
        <div className="max-w-md"><SelectField label="Default provider key" value={data.defaultKey || ""} disabled={busy}
          onChange={(event) => mutate({ action: "setDefault", name: event.target.value }, "Default key saved.")}>
          <option value="">No default</option>{data.keys.map((key) => <option key={key.name}>{key.name}</option>)}
        </SelectField></div>
      </Card>
      <Card title={`${data.keys.length} provider keys`} subtitle="Each member pins one account and one upstream model."
        action={<Button disabled={busy} onClick={() => setEditor({ name: "", strategy: "round-robin", members: [blankMember()], creating: true })}>Add key</Button>}>
        <Input label="Search provider keys" aria-label="Search provider keys" type="search" value={keySearch}
          placeholder="Key, strategy, account or model…" onChange={(event) => setKeySearch(event.target.value)} />
        {!data.keys.length && <p className="text-sm text-text-muted">Connect an account in Providers, then add a key here.</p>}
        {!!data.keys.length && !keys.length && <p className="py-4 text-sm text-text-muted">No matching provider keys.</p>}
        {keys.map((key) => <div key={key.name} className="py-4 border-b border-border-subtle last:border-0 flex flex-wrap gap-4 justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="font-semibold text-text-main break-all">{key.name}{data.defaultKey === key.name && <span className="ml-2 text-xs font-normal text-primary">Default</span>}</h3>
            <p className="text-xs text-text-muted">{key.strategy} · {key.contextWindow.toLocaleString()} context · {key.maxTokens.toLocaleString()} output</p>
            <ul className="text-sm text-text-muted space-y-1 pt-1">{key.members.map((member, index) => {
              const account = accounts.get(member.connectionId);
              return <li key={index} className="break-all">{account?.name || "Missing account"} → {member.model}
                {account && <span className="text-xs"> ({account.isActive ? account.testStatus || "untested" : "disabled"})</span>}</li>;
            })}</ul>
          </div>
          <div className="flex gap-2 items-start">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditor({ ...key, members: key.members.map((member) => ({ ...member })), creating: false })}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm({
              title: "Delete provider key", message: `Delete ${key.name}? Existing clients using this model will fail. History is retained.`,
              body: { action: "deleteKey", name: key.name }, done: "Provider key deleted.",
            })}>Delete</Button>
          </div>
        </div>)}
        <p className="mt-4 text-xs text-text-muted">The reserved <strong>all</strong> pool contains every configured member. Permission to use it does not authorize other model names.</p>
      </Card>
    </>}

    {data && !overview && tab === "tokens" && <Card title="Scoped tokens" subtitle="Secrets appear only at creation. Revocation denies subsequent requests."
      action={<Button disabled={busy || !names.length} onClick={() => setTokenForm({ name: "", allowedKeys: [] })}>Generate token</Button>}>
      <div className="max-w-xs mb-4"><SelectField label="Credential kind" value={tokenKind} onChange={(event) => setTokenKind(event.target.value)}>
        <option value="manual">Manual clients</option><option value="session">Sessions</option><option value="all">All credentials</option>
      </SelectField></div>
      <ScopedTokens tokens={tokens} busy={busy} onHistory={showSessionHistory} onRevoke={(token) => setConfirm({
          title: "Revoke credential", message: `Revoke ${token.name}? This immediately blocks the client. Session suspension must retain its credentials; do not revoke to pause a Room.`,
          body: { action: "revokeToken", id: token.id }, done: "Credential revoked.",
        })} />
    </Card>}

    {data && !overview && tab === "history" && <Card title="Request history" subtitle="Latest 200 attempts for the applied origin/session. Search and pages cover only these loaded results. No prompts, responses or credentials are stored here.">
      <RequestHistory requests={data.requests} accounts={accounts} tokens={data.tokens} />
    </Card>}

    <Modal isOpen={!!editor} onClose={closeEditor} title={editor?.creating ? "Add provider key" : "Edit provider key"} size="xl"
      footer={<><Button variant="ghost" disabled={busy} onClick={closeEditor}>Cancel</Button><Button loading={busy} disabled={!editor?.name.trim() || editor.members.some((member) => !member.connectionId || !member.model.trim())}
        onClick={() => mutate({ action: "saveKey", ...editor }, "Provider key saved.", () => setEditor(null))}>Save key</Button></>}>
      {editor && <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <Input label="Key name" aria-label="Key name" value={editor.name} disabled={!editor.creating || busy} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
        <SelectField label="Selection strategy" value={editor.strategy} disabled={busy} onChange={(event) => setEditor({ ...editor, strategy: event.target.value })}>
          {strategies.map((strategy) => <option key={strategy}>{strategy}</option>)}
        </SelectField>
        {editor.members.map((member, index) => <fieldset key={index} className="border border-border rounded-[10px] p-3 space-y-3">
          <legend className="text-sm text-text-muted px-1">Member {index + 1}</legend>
          <SelectField label={`Account ${index + 1}`} value={member.connectionId} disabled={busy} onChange={(event) => updateMember(index, { connectionId: event.target.value })}>
            <option value="">Select an account</option>{data?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.provider}{account.isActive ? "" : ", disabled"})</option>)}
          </SelectField>
          <Input label="Upstream model" aria-label={`Upstream model ${index + 1}`} hint="Use provider/model, for example claude/claude-sonnet-4-6. Saving validates the account binding, not upstream availability."
            value={member.model} disabled={busy} onChange={(event) => updateMember(index, { model: event.target.value })} />
          {editor.members.length > 1 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditor({ ...editor, members: editor.members.filter((_, i) => i !== index) })}>Remove member</Button>}
        </fieldset>)}
        <Button variant="secondary" disabled={busy} onClick={() => setEditor({ ...editor, members: [...editor.members, blankMember()] })}>Add member</Button>
      </div>}
    </Modal>

    <Modal isOpen={!!tokenForm} onClose={closeTokenForm} title="Generate scoped token" size="lg" footer={<>
      <Button variant="ghost" disabled={busy} onClick={closeTokenForm}>Cancel</Button>
      <Button loading={busy} disabled={!tokenForm?.name.trim() || !tokenForm?.allowedKeys.length}
        onClick={() => mutate({ action: "createToken", ...tokenForm }, "Token created. Save its secret before closing.", (result) => { setIssued(result); setTokenForm(null); })}>Generate</Button>
    </>}>
      {tokenForm && <div className="space-y-4">
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <Input label="Client name" aria-label="Client name" value={tokenForm.name} disabled={busy} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} />
        <fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">Allowed virtual models</legend>
          {names.map((name) => <label key={name} className="flex gap-3 items-start text-sm text-text-main break-all">
            <input type="checkbox" className="mt-1 accent-primary" disabled={busy} checked={tokenForm.allowedKeys.includes(name)} onChange={(event) => setTokenForm({ ...tokenForm, allowedKeys: event.target.checked ? [...tokenForm.allowedKeys, name] : tokenForm.allowedKeys.filter((key) => key !== name) })} />{name}
          </label>)}
        </fieldset>
      </div>}
    </Modal>

    <Modal isOpen={!!issued} onClose={() => setIssued(null)} title="Save this credential" size="lg" footer={<Button onClick={() => setIssued(null)}>I have saved it</Button>}>
      {issued && <div className="space-y-4">
        <p className="text-sm text-text-muted">This secret is shown once. Store it in the client&apos;s secret manager. It cannot be recovered from the token list.</p>
        <textarea aria-label="New token secret" readOnly value={issued.token} className="w-full bg-surface-2 text-text-main rounded-[10px] p-3 text-sm break-all" rows={3} />
        <p className="text-sm text-text-muted break-all">Allowed models: {issued.allowedKeys.join(", ")}</p>
      </div>}
    </Modal>
    <ConfirmModal isOpen={!!confirm} onClose={() => { if (!busy) setConfirm(null); }} title={confirm?.title} message={confirm?.message} loading={busy}
      onConfirm={() => mutate(confirm.body, confirm.done, () => setConfirm(null))} />
  </div>;
}
