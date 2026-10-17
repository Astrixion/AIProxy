"use client";

import { useState } from "react";
import {
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel,
  getSortedRowModel, useReactTable,
} from "@tanstack/react-table";
import { Button, Input } from "@/shared/components";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/components/ui/table";

export default function ManagementTable({ data, columns, label, emptyMessage, initialSorting = [] }) {
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState(initialSorting);
  const table = useReactTable({
    data, columns,
    state: { globalFilter: search, sorting },
    onGlobalFilterChange: setSearch,
    onSortingChange: setSorting,
    globalFilterFn: "includesString",
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 10 } },
  });
  const matching = table.getFilteredRowModel().rows;
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = Math.max(1, table.getPageCount());

  return <div className="min-w-0 space-y-4">
    <Input label={`Search ${label}`} aria-label={`Search ${label}`} type="search" value={search}
      placeholder="Search loaded results…" onChange={(event) => setSearch(event.target.value)} />
    <Table aria-label={label}>
      <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>
        {group.headers.map((header) => <TableHead key={header.id}
          aria-sort={header.column.getCanSort() ? ({ asc: "ascending", desc: "descending" }[header.column.getIsSorted()] || "none") : undefined}>
          {header.column.getCanSort() ? <button type="button"
            className="inline-flex items-center gap-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-primary"
            onClick={header.column.getToggleSortingHandler()}>
            {flexRender(header.column.columnDef.header, header.getContext())}
            <span aria-hidden="true">{{ asc: "↑", desc: "↓" }[header.column.getIsSorted()] || "↕"}</span>
          </button> : flexRender(header.column.columnDef.header, header.getContext())}
        </TableHead>)}
      </TableRow>)}</TableHeader>
      <TableBody>{table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <TableRow key={row.id}>
        {row.getVisibleCells().map((cell) => <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>)}
      </TableRow>) : <TableRow><TableCell colSpan={columns.length} className="h-24 text-center text-text-muted">
        {data.length ? "No matching results. Clear or change your search." : emptyMessage}
      </TableCell></TableRow>}</TableBody>
    </Table>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-muted">
      <p role="status">{matching.length ? pageIndex * pageSize + 1 : 0}–{Math.min((pageIndex + 1) * pageSize, matching.length)} of {matching.length} matching · {data.length} loaded</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">Rows
          <select aria-label={`Rows per page for ${label}`} value={pageSize}
            className="rounded-lg border border-border bg-surface-2 p-2 text-text-main"
            onChange={(event) => table.setPageSize(Number(event.target.value))}>
            {[10, 25, 50].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <Button size="sm" variant="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</Button>
        <span>Page {pageIndex + 1} of {pageCount}</span>
        <Button size="sm" variant="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</Button>
      </div>
    </div>
  </div>;
}
