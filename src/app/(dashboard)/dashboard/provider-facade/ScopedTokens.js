"use client";

import { useMemo } from "react";
import { Button } from "@/shared/components";
import ManagementTable from "./ManagementTable";

export default function ScopedTokens({ tokens, busy, onRevoke, onHistory }) {
  const columns = useMemo(() => [
    { accessorKey: "name", header: "Credential", cell: ({ row: { original: token } }) => <div className="min-w-40 max-w-60 break-all">
      <strong className="text-text-main">{token.name}</strong>
      <details className="text-xs text-text-muted"><summary className="cursor-pointer">Token ID</summary>{token.id}</details>
    </div> },
    { id: "scope", header: "Allowed models", accessorFn: (token) => token.allowedKeys.join(", "),
      cell: ({ getValue }) => <span className="inline-block min-w-32 max-w-60 break-words text-text-muted">{getValue()}</span> },
    { id: "session", header: "Client / session", accessorFn: (token) => token.externalSessionId ? `${token.externalSessionId} ${token.slot}` : "Manual client",
      cell: ({ row: { original: token } }) => token.externalSessionId ? <button type="button"
        className="min-w-32 max-w-52 break-all text-left text-xs text-primary underline focus-visible:outline-2 focus-visible:outline-primary"
        onClick={() => onHistory(token.externalSessionId)} aria-label={`View history for session ${token.externalSessionId}`}>
        {token.externalSessionId}<span className="block">{token.slot} · View history</span>
      </button> : <span className="text-xs text-text-muted">Manual client</span> },
    { id: "state", header: "State", accessorFn: (token) => token.isActive ? "Active" : "Revoked",
      cell: ({ getValue }) => <span className="text-xs text-text-main">{getValue()}</span> },
    { accessorKey: "createdAt", header: "Created", cell: ({ getValue }) => <span className="text-xs text-text-muted">{new Date(getValue()).toLocaleString()}</span> },
    { id: "actions", header: "Actions", enableSorting: false,
      cell: ({ row: { original: token } }) => token.isActive && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRevoke(token)}>Revoke</Button> },
  ], [busy, onRevoke, onHistory]);

  return <ManagementTable data={tokens} columns={columns} label="scoped tokens" emptyMessage="No credentials in this view." />;
}
