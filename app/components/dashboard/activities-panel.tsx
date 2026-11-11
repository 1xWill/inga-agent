"use client";

import Image from "next/image";
import type { ActivityItem } from "../../../src/types/dashboard";
import { CitationsBlock } from "./citations-block";
import { PaginationNav } from "./pagination";
import { clsNumber, colorForLabel, fmtNotional, fmtSignedUsd } from "./utils";

type ActivitiesPanelProps = {
  items: ActivityItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    maxPages: number;
  };
  agentFocus: string | null;
  agentLabelById: Map<string, string>;
  agentLogoById: Map<string, string | undefined>;
  showDecisions: boolean;
  onToggleDecisions: () => void;
  onPageChange: (page: number) => void;
  formatRelTime: (iso?: string) => string;
  onApplyFocus: (marketId?: string, outcomeId?: string) => void;
  expandedRows: Set<string>;
  onToggleRow: (id: string) => void;
  focusKey: string | null;
  spinGlyph: string;
  marketUrlById: Map<string, string>;
};

export function ActivitiesPanel({
  items,
  pagination,
  agentFocus,
  agentLabelById,
  agentLogoById,
  showDecisions,
  onToggleDecisions,
  onPageChange,
  formatRelTime,
  onApplyFocus,
  expandedRows,
  onToggleRow,
  focusKey,
  spinGlyph,
  marketUrlById,
}: ActivitiesPanelProps) {
  return (
    <section className="flex flex-col min-h-0 text-xs sm:text-sm">
      <div className="flex px-2 sm:px-4 py-2 items-center justify-between ">
        <h3>
          {agentFocus
            ? (agentLabelById.get(agentFocus) ?? agentFocus)
            : "ALL"}{" "}
          · {pagination.total}
        </h3>
        <button
          className="text-slate-400 hover:text-slate-100 hover:underline underline-offset-4 cursor-pointer uppercase"
          onClick={onToggleDecisions}
        >
          {showDecisions ? "[ HIDE DECISIONS ]" : "[ SHOW DECISIONS ]"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {items.length === 0 && (
          <div className="text-slate-300/50 p-4 text-center">No activity</div>
        )}
        {items.map((it) => {
          const actText = `${(it.action ?? "").toUpperCase()}${it.source ? " · " + it.source.toUpperCase() : ""}`;
          const url = it.marketUrl ?? marketUrlById.get(it.marketId);
          const isPending = it.pending === true;
          const st = it.status ? it.status.toLowerCase() : undefined;
          const isCanceled = st?.includes("cancel") || st?.includes("fail");
          const isNotSubmitted =
            st === "not_submitted" || it.notSubmitted === true;
          const time = formatRelTime(it.time);
          const rowKey = it.outcomeId
            ? `${it.marketId}:${it.outcomeId}`
            : it.marketId;
          const isFocused =
            focusKey === rowKey ||
            focusKey === it.marketId ||
            (focusKey?.startsWith(`${it.marketId}:`) ?? false);

          return (
            <div
              key={it.id}
              onClick={() => onApplyFocus(it.marketId, it.outcomeId)}
              className={`px-2 sm:px-4 py-2 border-b-1 border-emerald-400/10 cursor-pointer ${isFocused ? "bg-emerald-400/10" : ""}`}
            >
              <div className="flex items-start gap-2">
                {it.agentId && agentLogoById.get(it.agentId) && (
                  <Image
                    src={agentLogoById.get(it.agentId)!}
                    alt={agentLabelById.get(it.agentId) ?? it.agentId}
                    width={16}
                    height={16}
                    className="w-4 h-4 rounded mt-0.5"
                  />
                )}
                <div>
                  <span>{it.marketTitle ?? it.marketId}</span>
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-300/50 hover:text-slate-100 ml-1"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      ↗
                    </a>
                  )}
                </div>
              </div>
              <div className="mt-1 pt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                <div className="text-slate-300/50 text-xs">ACTION</div>
                <div className="text-slate-300/50 text-xs text-right">
                  NOTIONAL / REAL P&L
                </div>
                <div className={`uppercase tracking-wide ${colorForLabel(it.action)}`}>
                  <span>{actText}</span>
                  {isPending ? (
                    <span>{`  ${spinGlyph}`}</span>
                  ) : isCanceled ? (
                    <span className="text-rose-400">{`  x`}</span>
                  ) : isNotSubmitted ? (
                    <span
                      title="Not submitted"
                      className="text-slate-300/60"
                    >{`  ?`}</span>
                  ) : null}
                </div>
                <div className="text-right">
                  {it.outcomeName ?? it.outcomeId ?? "—"}
                  <span className="text-slate-300/50 text-xs"> for </span>
                  {typeof it.notional === "number" &&
                    `$${fmtNotional(it.notional)}`}
                  <span>
                    <span> / </span>
                    {typeof it.pnl === "number" ? (
                      <span className={`${clsNumber(it.pnl)}`}>
                        {fmtSignedUsd(it.pnl)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-300/50">{time}</span>
                {it.rationale && (
                  <div className="mt-1">
                    <button
                      className="text-slate-400 hover:text-slate-100 hover:underline underline-offset-2 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleRow(`act:${it.id}`);
                      }}
                    >
                      {expandedRows.has(`act:${it.id}`)
                        ? "HIDE RATIONALE"
                        : "SHOW RATIONALE"}
                    </button>
                  </div>
                )}
              </div>
              {it.rationale && (
                <div
                  className={`mt-1 text-slate-300 whitespace-pre-wrap overflow-hidden duration-300 ease-in-out ${expandedRows.has(`act:${it.id}`) ? "max-h-[480px] opacity-100" : "max-h-0 opacity-0"}`}
                >
                  {it.rationale}
                  {Array.isArray(it.citations) && it.citations.length > 0 && (
                    <div className="mt-2 text-slate-300/70">
                      <CitationsBlock
                        urls={it.citations}
                        first={5}
                        label="Sources:"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {(() => {
          const unclampedPages =
            pagination.limit > 0
              ? Math.ceil(pagination.total / pagination.limit)
              : 1;
          const totalPages = Math.max(
            1,
            Math.min(pagination.maxPages ?? unclampedPages, unclampedPages),
          );
          return (
            <PaginationNav
              current={pagination.page}
              totalPages={totalPages}
              onChange={onPageChange}
            />
          );
        })()}
      </div>
    </section>
  );
}
