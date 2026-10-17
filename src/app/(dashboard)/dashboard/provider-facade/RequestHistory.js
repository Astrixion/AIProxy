"use client";

import { useMemo } from "react";
import ManagementTable from "./ManagementTable";

const date = (value) => value ? new Date(value).toLocaleString() : "Unknown";
const number = (value) => value == null ? "Unknown" : value.toLocaleString();

export default function RequestHistory({ requests, accounts, tokens }) {
  const columns = useMemo(() => [
    { accessorKey: "startedAt", header: "Started", cell: ({ row }) => <div className="min-w-36 text-xs text-text-muted">
      <span>{date(row.original.startedAt)}</span>
      <p>{row.original.completedAt ? `${((Date.parse(row.original.completedAt) - Date.parse(row.original.startedAt)) / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s` : "Not completed"}</p>
    </div> },
    { id: "route", header: "Route", accessorFn: (request) => [request.virtualKey, request.provider, request.upstreamModel, accounts.get(request.connectionId)?.name, request.connectionId].join(" "),
      cell: ({ row: { original: request } }) => <div className="min-w-48 max-w-72 break-words">
        <strong className="text-text-main">{request.virtualKey}</strong>
        <p className="text-xs text-text-muted">{accounts.get(request.connectionId)?.name || request.connectionId} → {request.upstreamModel}</p>
      </div> },
    { id: "client", header: "Client / session", accessorFn: (request) => [request.externalSessionId, request.slot, tokens.find((token) => token.id === request.tokenId)?.name, request.tokenId, request.id].join(" "),
      cell: ({ row: { original: request } }) => <div className="min-w-40 max-w-56 break-all text-xs text-text-muted">
        {request.externalSessionId ? <><span>Session {request.externalSessionId}</span><p>{request.slot}</p></>
          : <><span>Manual client</span><p>{tokens.find((token) => token.id === request.tokenId)?.name || "Unknown token"}</p></>}
        <details className="mt-1"><summary className="cursor-pointer">Request ID</summary>{request.id}</details>
      </div> },
    { accessorKey: "status", header: "Status", cell: ({ getValue }) => <span className="text-xs text-text-main">{getValue()}</span> },
    { id: "usage", header: "Reported usage", enableSorting: false,
      cell: ({ row: { original: request } }) => request.usage ? <div className="min-w-48 text-xs text-text-muted">
        <p>Input {number(request.usage.input)} · Output {number(request.usage.output)}</p>
        <p>Cache read {number(request.usage.cacheRead)} · Write {number(request.usage.cacheWrite)}</p>
        <p>{request.usage.complete ? "Completed request" : "Incomplete request"}</p>
      </div> : <span className="text-xs text-text-muted">Usage unavailable</span> },
  ], [accounts, tokens]);

  return <ManagementTable data={requests} columns={columns} label="request history" emptyMessage="No recorded requests in this view."
    initialSorting={[{ id: "startedAt", desc: true }]} />;
}
