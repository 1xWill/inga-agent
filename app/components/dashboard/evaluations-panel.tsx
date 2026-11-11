"use client";

import Image from "next/image";
import type { MarketEvaluationView } from "../../../src/types/dashboard";
import { CitationsBlock } from "./citations-block";
import { PaginationNav } from "./pagination";
import { colorForLabel } from "./utils";

type EvaluationsPanelProps = {
  items: MarketEvaluationView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    maxPages: number;
  };
  agentFocus: string | null;
  agentLabelById: Map<string, string>;
  agentLogoById: Map<string, string | undefined>;
  showRejected: boolean;
  onToggleRejected: () => void;
  onPageChange: (page: number) => void;
  formatRelOrLocal: (iso?: string) => string;
  onApplyFocus: (marketId?: string) => void;
  expandedRows: Set<string>;
  onToggleRow: (id: string) => void;
  focusKey: string | null;
};

export function EvaluationsPanel({
  items,
  pagination,
  agentFocus,
  agentLabelById,
  agentLogoById,
  showRejected,
  onToggleRejected,
  onPageChange,
  formatRelOrLocal,
  onApplyFocus,
  expandedRows,
  onToggleRow,
  focusKey,
}: EvaluationsPanelProps) {
  return (
    <section className="flex flex-col min-h-0 text-xs sm:text-sm">
      <div className="flex px-2 sm:px-4 py-2 items-center justify-between">
        <h3>
          {agentFocus
            ? (agentLabelById.get(agentFocus) ?? agentFocus)
            : "ALL"}{" "}
          · {pagination.total}
        </h3>
        <button
          className="text-slate-400 hover:text-slate-100 hover:underline underline-offset-4 cursor-pointer uppercase"
          onClick={onToggleRejected}
        >
          {showRejected ? "[ HIDE REJECTED ]" : "[ SHOW REJECTED ]"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {items.length === 0 && (
          <div className="text-slate-300/50 p-4 text-center">
            No evaluations
          </div>
        )}
        {items.map((e) => {
          const isFocused =
            focusKey === e.marketId ||
            (focusKey?.startsWith(`${e.marketId}:`) ?? false);
          return (
            <div
              key={e.id}
              onClick={() => onApplyFocus(e.marketId)}
              className={`px-2 sm:px-4 py-2 border-b-1 border-emerald-400/10 cursor-pointer ${isFocused ? "bg-emerald-400/10" : ""}`}
            >
              <div className="flex items-start gap-2">
                {e.agentId && agentLogoById.get(e.agentId) && (
                  <Image
                    src={agentLogoById.get(e.agentId)!}
                    alt={agentLabelById.get(e.agentId) ?? e.agentId}
                    width={16}
                    height={16}
                    className="w-4 h-4 rounded mt-0.5"
                  />
                )}
                <div>
                  <span>{e.title}</span>
                  {e.url && (
                    <a
                      href={e.url}
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
              <div className="mt-1 flex items-center justify-between text-xs">
                <div className="flex tracking-wide items-center gap-2">
                  <span
                    className={colorForLabel(
                      e.trade ? "ACCEPTED" : "REJECTED",
                    )}
                  >
                    {e.trade ? "ACCEPTED" : "REJECTED"}
                  </span>
                  <span className="text-slate-300/50">·</span>
                  <span className="text-slate-300/50">
                    {formatRelOrLocal(e.createdAt)}
                  </span>
                </div>
                {e.quickSummary && (
                  <button
                    className="text-slate-400 hover:text-slate-100 hover:underline underline-offset-2 cursor-pointer"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onToggleRow(`eval:${e.id}`);
                    }}
                  >
                    {expandedRows.has(`eval:${e.id}`)
                      ? "HIDE SUMMARY"
                      : "SHOW SUMMARY"}
                  </button>
                )}
              </div>
              {e.quickSummary && (
                <div
                  className={`mt-1 text-slate-300 whitespace-pre-wrap overflow-hidden duration-300 ease-in-out ${expandedRows.has(`eval:${e.id}`) ? "max-h-[480px] opacity-100" : "max-h-0 opacity-0"}`}
                >
                  {e.quickSummary}
                  {Array.isArray(e.citations) && e.citations.length > 0 && (
                    <div className="mt-2 text-slate-300/70">
                      <CitationsBlock
                        urls={e.citations}
                        first={5}
                        label="Citations:"
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
