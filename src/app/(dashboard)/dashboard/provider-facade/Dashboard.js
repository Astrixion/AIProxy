"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function Dashboard({ requests }) {
  const statuses = new Map();
  for (const request of requests) statuses.set(request.status, (statuses.get(request.status) || 0) + 1);
  const outcomes = Array.from(statuses, ([status, attempts]) => ({ status, attempts }));
  const fields = [["input", "Input"], ["output", "Output"], ["cacheRead", "Cache read"], ["cacheWrite", "Cache write"]];

  return <section aria-label="Loaded request summary" className="space-y-3">
    <div>
      <h4 className="font-medium text-text-main">Loaded request summary · {requests.length} matching attempts</h4>
      <p className="text-xs text-text-muted">Summary of the latest 200 attempts for the applied origin/session. These are not lifetime totals.</p>
    </div>
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {fields.map(([field, label]) => {
        const reported = requests.filter((request) => request.usage?.[field] != null);
        const total = reported.reduce((sum, request) => sum + request.usage[field], 0);
        return <div key={field} className="rounded-[10px] border border-border bg-surface-2 p-3">
          <dt className="text-xs text-text-muted">{label} tokens reported</dt>
          <dd className="text-xl font-semibold text-text-main">{reported.length ? total.toLocaleString() : "Unknown"}</dd>
          <dd className="text-xs text-text-muted">Reported in {reported.length} of {requests.length} attempts</dd>
        </div>;
      })}
    </dl>
    <p className="text-xs text-text-muted">Reported counts may be partial, including for completed requests. Missing values are not counted as zero.</p>
    {requests.length > 0 ? <div className="h-56 min-w-0" role="img" aria-label={outcomes.map(({ status, attempts }) => `${status}: ${attempts} attempts`).join(", ")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={outcomes} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid horizontal={false} stroke="var(--color-border)" />
          <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--color-text-muted)", fontSize: 12 }} />
          <YAxis type="category" dataKey="status" width={112} tick={{ fill: "var(--color-text-muted)", fontSize: 12 }} />
          <Tooltip cursor={{ fill: "var(--color-surface-2)" }} contentStyle={{ background: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-main)", borderRadius: 10 }} />
          <Bar dataKey="attempts" name="Attempts" fill="var(--color-primary)" radius={[0, 4, 4, 0]} maxBarSize={30} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div> : <p className="text-sm text-text-muted">No recorded requests in this view.</p>}
  </section>;
}
