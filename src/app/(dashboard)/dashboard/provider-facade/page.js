"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Input, Modal, ConfirmModal } from "@/shared/components";

const strategies = ["round-robin", "fill-first", "random", "least-used"];
const blankMember = () => ({ connectionId: "", model: "" });
const date = (value) => value ? new Date(value).toLocaleString() : "Unknown";

function SelectField({ label, children, ...props }) {
  return <label className="flex flex-col gap-1.5 text-sm font-medium text-text-main">
    {label}
    <select className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5 text-text-main focus:outline-2 focus:outline-primary min-w-0" {...props}>{children}</select>
  </label>;
}

async function api(body, query = "") {
  const response = await fetch(`/api/provider-facade${query}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function ProviderFacadePage() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("keys");
  const [kind, setKind] = useState("all");
  const [tokenKind, setTokenKind] = useState("manual");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [tokenForm, setTokenForm] = useState(null);
  const [issued, setIssued] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(null, `?kind=${kind}&limit=200`));
      setError("");
    } catch (failure) {
      setError(failure.message);
    } finally { setLoading(false); }
  }, [kind]);
  useEffect(() => { load(); }, [load]);

  async function mutate(body, message, done = () => {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api(body);
      done(result);
      setNotice(message);
      await load();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  function updateMember(index, patch) {
    setEditor((current) => ({ ...current, members: current.members.map((member, i) => i === index ? { ...member, ...patch } : member) }));
  }

  const accounts = new Map(data?.accounts.map((account) => [account.id, account]) || []);
  const tokens = data?.tokens.filter((token) => tokenKind === "all" || token.kind === tokenKind) || [];
  const names = [...(data?.keys.map((key) => key.name) || []), ...(data?.reservedKey.memberCount ? ["all"] : [])];
  const closeEditor = () => { if (!busy) setEditor(null); };
  const closeTokenForm = () => { if (!busy) setTokenForm(null); };

  return <div className="space-y-6 max-w-6xl mx-auto pb-8">
    <header className="flex flex-wrap justify-between items-start gap-4">
      <div className="space-y-2 max-w-2xl">
        <h1 className="text-2xl font-semibold text-text-main">Scoped providers</h1>
        <p className="text-sm text-text-muted">Exact-account pools and credentials for Misanthropic, Sonar and other Messages clients. Account logins stay in <Link className="underline text-primary" href="/dashboard/providers">Providers</Link>.</p>
      </div>
      <Button variant="secondary" onClick={load} disabled={busy} loading={loading}>Refresh</Button>
    </header>

    {error && <div role="alert" className="rounded-[10px] border border-red-500/30 bg-red-500/10 p-4 text-sm text-text-main">
      {error} {data && <span>Displayed data may be stale.</span>}
    </div>}
    {notice && <p role="status" className="text-sm text-text-main">{notice}</p>}
    <nav aria-label="Scoped provider sections" className="flex flex-wrap gap-2 border-b border-border pb-3">
      {[["keys", "Provider keys"], ["tokens", "Scoped tokens"], ["history", "Request history"]].map(([value, label]) =>
        <Button key={value} variant={tab === value ? "primary" : "ghost"} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</Button>)}
    </nav>
    {!data && <p className="text-text-muted">{loading ? "Loading provider state…" : "Provider state is unavailable. Sign in and refresh to retry."}</p>}

    {data && tab === "keys" && <>
      <Card title="Default key" subtitle="Used when a lifecycle caller omits its key. Inference requests must still name a model.">
        <div className="max-w-md"><SelectField label="Default provider key" value={data.defaultKey || ""} disabled={busy}
          onChange={(event) => mutate({ action: "setDefault", name: event.target.value }, "Default key saved.")}>
          <option value="">No default</option>{data.keys.map((key) => <option key={key.name}>{key.name}</option>)}
        </SelectField></div>
      </Card>
      <Card title={`${data.keys.length} provider keys`} subtitle="Each member pins one account and one upstream model."
        action={<Button disabled={busy} onClick={() => setEditor({ name: "", strategy: "round-robin", members: [blankMember()], creating: true })}>Add key</Button>}>
        {!data.keys.length && <p className="text-sm text-text-muted">Connect an account in Providers, then add a key here.</p>}
        {data.keys.map((key) => <div key={key.name} className="py-4 border-b border-border-subtle last:border-0 flex flex-wrap gap-4 justify-between">
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

    {data && tab === "tokens" && <Card title="Scoped tokens" subtitle="Secrets appear only at creation. Revocation denies subsequent requests."
      action={<Button disabled={busy || !names.length} onClick={() => setTokenForm({ name: "", allowedKeys: [] })}>Generate token</Button>}>
      <div className="max-w-xs mb-4"><SelectField label="Credential kind" value={tokenKind} onChange={(event) => setTokenKind(event.target.value)}>
        <option value="manual">Manual clients</option><option value="session">Sessions</option><option value="all">All credentials</option>
      </SelectField></div>
      {!tokens.length && <p className="text-sm text-text-muted">No credentials in this view.</p>}
      {tokens.map((token) => <div key={token.id} className="py-4 border-b border-border-subtle last:border-0 flex flex-wrap justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="font-semibold text-text-main break-all">{token.name} <span className={`text-xs font-normal ${token.isActive ? "text-primary" : "text-text-muted"}`}>{token.isActive ? "Active" : "Revoked"}</span></h3>
          <p className="text-sm text-text-muted break-all">Allowed models: {token.allowedKeys.join(", ")}</p>
          <p className="text-xs text-text-muted break-all">{token.kind === "session" ? `Session ${token.externalSessionId} · ${token.slot}` : "Manual client"} · Created {date(token.createdAt)}</p>
        </div>
        {token.isActive && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm({
          title: "Revoke credential", message: `Revoke ${token.name}? This immediately blocks the client. Session suspension must retain its credentials; do not revoke to pause a Room.`,
          body: { action: "revokeToken", id: token.id }, done: "Credential revoked.",
        })}>Revoke</Button>}
      </div>)}
    </Card>}

    {data && tab === "history" && <Card title="Request history" subtitle="Latest 200 attempts. No prompts, responses or credentials are stored here.">
      <div className="max-w-xs mb-4"><SelectField label="Request origin" value={kind} disabled={loading} onChange={(event) => setKind(event.target.value)}>
        <option value="all">All requests</option><option value="manual">Manual clients</option><option value="session">Sessions</option>
      </SelectField></div>
      {!data.requests.length && <p className="text-sm text-text-muted">No recorded requests in this view.</p>}
      {data.requests.map((request) => <article key={request.id} className="py-4 border-b border-border-subtle last:border-0 space-y-1">
        <div className="flex flex-wrap gap-x-4 gap-y-1 justify-between text-sm">
          <strong className="text-text-main break-all">{request.virtualKey}</strong><span className="text-text-muted">{date(request.startedAt)} · {request.status}</span>
        </div>
        <p className="text-sm text-text-muted break-all">{accounts.get(request.connectionId)?.name || request.connectionId} → {request.upstreamModel}</p>
        <p className="text-xs text-text-muted break-all">{request.externalSessionId ? `Session ${request.externalSessionId} · ${request.slot}` : `Manual · ${data.tokens.find((token) => token.id === request.tokenId)?.name || "unknown token"}`}</p>
        <p className="text-xs text-text-muted">{request.usage
          ? `Input ${request.usage.input ?? "unknown"} · Output ${request.usage.output ?? "unknown"} · Cache read ${request.usage.cacheRead ?? "unknown"} · Cache write ${request.usage.cacheWrite ?? "unknown"} · ${request.usage.complete ? "Complete usage" : "Incomplete usage"}`
          : "Usage unavailable"}</p>
      </article>)}
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
