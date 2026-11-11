"use client";

import Image from "next/image";
import type { MutableRefObject } from "react";
import type {
  ClosedPositionsPage,
  FillView,
  PortfolioView,
  PositionView,
} from "../../../src/types/dashboard";
import { fmtNotional, fmtPnl, fmtPrice, clsNumber } from "./utils";
import type { PositionsByAgent } from "./derive";
import { PaginationNav } from "./pagination";

type Agent = {
  id: string;
  label: string;
  logo?: string;
};

export type PositionsPanelProps = {
  agents: Agent[];
  portfolios: Record<string, PortfolioView>;
  fills: FillView[];
  positionsByAgent: PositionsByAgent;
  agentFocus: string | null;
  focusKey: string | null;
  focusLabel: string;
  onClearAgentFocus: () => void;
  onClearFocus: () => void;
  onApplyFocus: (marketId?: string, outcomeId?: string) => void;
  markBasis: "ask" | "bid";
  onToggleMarkBasis: () => void;
  pnlMode: "total" | "realized" | "unrealized";
  onTogglePnlMode: () => void;
  collapsedAgents: Set<string>;
  onToggleCollapsed: (agentId: string) => void;
  showClosedByAgent: Set<string>;
  loadingClosedByAgent: Set<string>;
  onToggleShowClosed: (agentId: string) => void;
  onClosedPageChange: (agentId: string, page: number) => void;
  isShowClosed: (agentId: string) => boolean;
  closedPages: Record<string, ClosedPositionsPage | undefined>;
  formatRelTime: (iso?: string) => string;
  agentLabelById: Map<string, string>;
  spinGlyph: string;
  markBasisTitle: string;
  markToggleLabel: string;
  positionRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  openPageSize: number;
  maxOpenPages: number;
  openPageByAgent: Map<string, number>;
  onOpenPageChange: (agentId: string, page: number) => void;
};

export function PositionsPanel({
  agents,
  portfolios,
  fills,
  positionsByAgent,
  agentFocus,
  focusKey,
  focusLabel,
  onClearAgentFocus,
  onClearFocus,
  onApplyFocus,
  markBasis,
  onToggleMarkBasis,
  pnlMode,
  onTogglePnlMode,
  collapsedAgents,
  onToggleCollapsed,
  showClosedByAgent,
  loadingClosedByAgent,
  onToggleShowClosed,
  onClosedPageChange,
  isShowClosed,
  closedPages,
  formatRelTime,
  agentLabelById,
  spinGlyph,
  markBasisTitle,
  markToggleLabel,
  positionRefs,
  openPageSize,
  maxOpenPages,
  openPageByAgent,
  onOpenPageChange,
}: PositionsPanelProps) {
  return (
    <section className="flex flex-col min-h-0 text-xs sm:text-sm">
      <div className="px-2 sm:px-4 flex gap-2 items-center text-xs sm:text-sm">
        {agentFocus && (
          <button
            className="inline-block px-2 py-0.5 mt-2 border-[1.5px] border-emerald-400/40 hover:border-emerald-400 hover:text-emerald-400 cursor-pointer"
            onClick={onClearAgentFocus}
            title="Clear agent focus"
          >
            {agentLabelById.get(agentFocus) ?? agentFocus} ✕
          </button>
        )}
        {focusKey && (
          <button
            className="inline-block px-2 py-0.5 mt-2 border-[1.5px] border-emerald-400/40 hover:border-emerald-400 hover:text-emerald-400 cursor-pointer"
            onClick={onClearFocus}
            title="Clear focus"
          >
            <span className="truncate" title={focusLabel}>
              {focusLabel}
            </span>{" "}
            ✕
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {agents
          .filter((a) => !agentFocus || a.id === agentFocus)
          .map((a) => {
            const port = portfolios[a.id];
            const open = positionsByAgent[a.id]?.open ?? [];
            const closed = positionsByAgent[a.id]?.closed ?? [];
            const closedState = closedPages[a.id];
            const closedPagination = closedState?.pagination;
            const totalClosedPages = closedPagination
              ? Math.max(
                  1,
                  Math.ceil(closedPagination.total / closedPagination.limit),
                )
              : 1;
            const closedPage = closedPagination?.page ?? 1;
            const isCollapsed = collapsedAgents.has(a.id);
            const calcUPnl = (p: PositionView) => {
              const bid = typeof p.bestBid === "number" ? p.bestBid : undefined;
              const mark = typeof bid === "number" ? bid : p.averagePrice;
              return (mark - p.averagePrice) * p.quantity;
            };
            const openSorted = [...open].sort(
              (x, y) => calcUPnl(y) - calcUPnl(x),
            );
            const pageSize = Math.max(1, openPageSize);
            const cappedOpen = openSorted.slice(
              0,
              pageSize * Math.max(1, maxOpenPages),
            );
            const totalOpenPages = Math.max(
              1,
              Math.ceil(cappedOpen.length / pageSize),
            );
            const requestedPage = openPageByAgent.get(a.id) ?? 1;
            const currentOpenPage = Math.min(
              totalOpenPages,
              Math.max(1, requestedPage),
            );
            const openStart = (currentOpenPage - 1) * pageSize;
            const openDisplay = cappedOpen.slice(
              openStart,
              openStart + pageSize,
            );
            const agentUnreal =
              typeof port?.unrealizedPnl === "number"
                ? port.unrealizedPnl
                : open.reduce((acc, p) => {
                    const mark =
                      markBasis === "ask"
                        ? typeof p.bestAsk === "number"
                          ? p.bestAsk
                          : typeof p.bestBid === "number"
                            ? p.bestBid
                            : p.averagePrice
                        : typeof p.bestBid === "number"
                          ? p.bestBid
                          : typeof p.bestAsk === "number"
                            ? p.bestAsk
                            : p.averagePrice;
                    return acc + (mark - p.averagePrice) * p.quantity;
                  }, 0);
            const positionsValueAgent = open.reduce((acc, p) => {
              const markVal =
                markBasis === "ask"
                  ? typeof p.bestAsk === "number"
                    ? p.bestAsk
                    : typeof p.bestBid === "number"
                      ? p.bestBid
                      : p.averagePrice
                  : typeof p.bestBid === "number"
                    ? p.bestBid
                    : typeof p.bestAsk === "number"
                      ? p.bestAsk
                      : p.averagePrice;
              return acc + markVal * p.quantity;
            }, 0);
            const equityAgent =
              typeof port?.equity === "number"
                ? port.equity
                : (port?.cashBalance ?? 0) + positionsValueAgent;
            const baseline =
              typeof port?.baselineEquity === "number"
                ? port.baselineEquity
                : undefined;
            const agentTotal =
              typeof equityAgent === "number" && typeof baseline === "number"
                ? equityAgent - baseline
                : (port?.realizedPnl ?? 0) + agentUnreal;
            const agentReal = agentTotal - agentUnreal;
            const agentLastTrade = (() => {
              const rows = fills.filter((f) => f.agentId === a.id);
              return rows.length ? rows[0].createdAt : undefined;
            })();
            const agentUpdated = (() => {
              const times = (port?.positions ?? []).map((p) => {
                const t = (p as any).lastMarkedAt || (p as any).updatedAt;
                return t ? new Date(t as string).getTime() : 0;
              });
              const mx = times.reduce((m, v) => Math.max(m, v), 0);
              return mx ? new Date(mx).toISOString() : undefined;
            })();
            return (
              <div
                key={a.id}
                className="border-b-[1.5px] border-emerald-400/20 text-xs sm:text-sm"
              >
                <div className="px-4 py-2">
                  <div className="flex items-center justify-between">
                    <h4
                      className="font-semibold cursor-pointer flex items-center gap-2 hover:underline underline-offset-2"
                      onClick={() => onToggleCollapsed(a.id)}
                    >
                      {a.logo && (
                        <Image
                          src={a.logo}
                          alt={a.label}
                          width={16}
                          height={16}
                          className="w-4 h-4 rounded"
                        />
                      )}
                      <span>
                        {a.label} ·{" "}
                        {open.length}
                      </span>
                    </h4>
                    <button
                      className="text-slate-300/50 hover:text-slate-100 hover:underline underline-offset-4 cursor-pointer uppercase"
                      onClick={onTogglePnlMode}
                    >
                      [
                      {pnlMode === "total"
                        ? "Total P&L"
                        : pnlMode === "realized"
                          ? "Real P&L"
                          : "Unreal P&L"}
                      :{" "}
                      <span
                        className={`${clsNumber(
                          pnlMode === "total"
                            ? agentTotal
                            : pnlMode === "realized"
                              ? agentReal
                              : agentUnreal,
                        )}`}
                      >
                        {port
                          ? `$${fmtNotional(
                              pnlMode === "total"
                                ? agentTotal
                                : pnlMode === "realized"
                                  ? agentReal
                                  : agentUnreal,
                            )}`
                          : spinGlyph}
                      </span>
                      ]
                    </button>
                  </div>
                  <div className="text-slate-300/50 text-xs flex items-center justify-between mt-1">
                    <span>Traded {formatRelTime(agentLastTrade)}</span>
                    <span>
                      Updated{" "}
                      {agentUpdated
                        ? formatRelTime(agentUpdated)
                        : port
                          ? "—"
                          : spinGlyph}
                    </span>
                  </div>
                </div>
                {!isCollapsed && (
                  <div>
                    {openDisplay.length === 0 && (
                      <div className="text-slate-300/50 p-3 text-center">
                        {port ? (
                          "No open positions"
                        ) : (
                          <>Loading positions {spinGlyph}</>
                        )}
                      </div>
                    )}
                    {openDisplay.map((p) => {
                      const key = `${p.marketId}:${p.optionId}`;
                      const mark = (() => {
                        const byAsk =
                          typeof p.bestAsk === "number" ? p.bestAsk : undefined;
                        const byBid =
                          typeof p.bestBid === "number" ? p.bestBid : undefined;
                        return markBasis === "ask"
                          ? (byAsk ?? byBid)
                          : (byBid ?? byAsk);
                      })();
                      const notional =
                        typeof mark === "number"
                          ? mark * p.quantity
                          : p.averagePrice * p.quantity;
                      const abs =
                        typeof mark === "number"
                          ? (mark - p.averagePrice) * p.quantity
                          : undefined;
                      const cost = p.averagePrice * p.quantity;
                      const f = fmtPnl(abs, cost);
                      const markCls =
                        typeof mark === "number"
                          ? mark > p.averagePrice
                            ? "text-emerald-400"
                            : mark < p.averagePrice
                              ? "text-rose-400"
                              : ""
                          : "";
                      const hasTargets =
                        typeof p.tpPrice === "number" ||
                        typeof p.slPrice === "number";
                      const avgEntryClass = hasTargets
                        ? "relative inline-flex items-center gap-1 group"
                        : "relative inline-flex items-center gap-1";
                      const isFocused =
                        focusKey === key ||
                        focusKey === p.marketId ||
                        (focusKey?.startsWith(`${p.marketId}:`) ?? false);
                      return (
                        <div
                          key={key}
                          ref={(el) => {
                            if (el) positionRefs.current.set(key, el);
                          }}
                          onClick={() => onApplyFocus(p.marketId, p.optionId)}
                          className={`px-2 sm:px-4 py-2 border-b-1 border-emerald-400/10 cursor-pointer ${isFocused ? "bg-emerald-400/10" : ""}`}
                        >
                          <div>
                            <span>{p.marketTitle ?? p.marketId}</span>
                            {p.marketUrl && (
                              <a
                                href={p.marketUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-slate-300/50 hover:text-slate-100 ml-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                ↗
                              </a>
                            )}
                          </div>
                          <div className="mt-1 grid grid-cols-2">
                            <span className="text-slate-300/50 text-xs">
                              OUTCOME
                            </span>
                            <span className="text-slate-300/50 text-xs text-right">
                              NOTIONAL
                            </span>
                            <span>{p.outcomeName ?? "—"}</span>
                            <span className="text-right">
                              ${fmtNotional(notional)}
                            </span>
                          </div>
                          <div className="mt-1 grid grid-cols-2">
                            <div className="text-slate-300/50 text-xs flex items-center gap-2">
                              <span className={avgEntryClass}>
                                AVG ENTRY /
                                {hasTargets && (
                                  <div className="absolute left-0 bottom-full mb-1 hidden group-hover:flex flex-col gap-0.5 bg-emerald-950/95 text-slate-100 px-2 py-1 text-[10px] sm:text-xs whitespace-nowrap rounded shadow-lg z-20">
                                    {typeof p.tpPrice === "number" && (
                                      <div>TP: ${fmtPrice(p.tpPrice)}</div>
                                    )}
                                    {typeof p.slPrice === "number" && (
                                      <div>SL: ${fmtPrice(p.slPrice)}</div>
                                    )}
                                  </div>
                                )}
                              </span>
                              <button
                                className="ml-1 underline-offset-2 hover:underline cursor-pointer"
                                title={markBasisTitle}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onToggleMarkBasis();
                                }}
                              >
                                {markToggleLabel}
                              </button>
                            </div>
                            <div className="text-slate-300/50 text-xs text-right group relative">
                              UNREALIZED P&L
                              {typeof (p as any).feesPaid === "number" && (
                                <div className="absolute right-0 bottom-full mb-1 hidden group-hover:block bg-emerald-900 text-slate-300 px-2 py-1 text-xs whitespace-nowrap z-10">
                                  FEES: ${fmtNotional((p as any).feesPaid)}
                                </div>
                              )}
                            </div>
                            <div>
                              {typeof p.averagePrice === "number" &&
                              p.averagePrice > 0
                                ? `$${fmtPrice(p.averagePrice)}`
                                : spinGlyph}{" "}
                              /{" "}
                              <span className={`${markCls}`}>
                                ${fmtPrice(mark)}
                              </span>
                            </div>
                            <div className={`text-right ${clsNumber(abs)}`}>
                              ${f.abs}{" "}
                              <span className="text-slate-300/80">
                                ({f.pct})
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <PaginationNav
                      current={currentOpenPage}
                      totalPages={totalOpenPages}
                      onChange={(page) => onOpenPageChange(a.id, page)}
                      className="px-2 sm:px-4 py-1 text-center"
                      stopPropagation
                    />
                    {isShowClosed(a.id) && (
                      <>
                        <div className="border-t-[1.5px] border-emerald-400/30" />
                        {loadingClosedByAgent.has(a.id) && (
                          <div className="text-slate-300/50 p-2 text-center">
                            Loading closed positions {spinGlyph}
                          </div>
                        )}
                        {!loadingClosedByAgent.has(a.id) &&
                          closed.length === 0 && (
                            <div className="text-slate-300/50 p-4 text-center">
                              No closed positions
                            </div>
                          )}
                        {closed.map((p, idx) => {
                          const baseKey = `${p.marketId}:${p.optionId}`;
                          const key = `${baseKey}:${idx}`;
                          const entryPrice =
                            typeof p.averagePrice === "number"
                              ? p.averagePrice
                              : undefined;
                          const notional = (entryPrice ?? 0) * p.quantity;
                          const exitPrice =
                            typeof p.exitPrice === "number"
                              ? p.exitPrice
                              : typeof (p as any).exitPrice === "number"
                                ? (p as any).exitPrice
                                : undefined;
                          const exitCls =
                            typeof exitPrice === "number" &&
                            typeof entryPrice === "number"
                              ? exitPrice > entryPrice
                                ? "text-emerald-400"
                                : exitPrice < entryPrice
                                  ? "text-rose-400"
                                  : ""
                              : "";
                          const realized =
                            typeof p.realizedPnlForPosition === "number"
                              ? p.realizedPnlForPosition
                              : typeof (p as any).realizedPnl === "number"
                                ? (p as any).realizedPnl
                                : undefined;
                          return (
                            <div
                              key={key}
                              className="px-2 sm:px-4 py-2 border-b-1 border-emerald-400/10"
                            >
                              <div>
                                <span>{p.marketTitle ?? p.marketId}</span>
                                {p.marketUrl && (
                                  <a
                                    href={p.marketUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-slate-300/50 hover:text-slate-100 ml-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    ↗
                                  </a>
                                )}
                              </div>
                              <div className="mt-1 grid grid-cols-2">
                                <div className="text-slate-300/50 text-xs">
                                  OUTCOME
                                </div>
                                <div className="text-slate-300/50 text-xs text-right">
                                  NOTIONAL
                                </div>
                                <div>{p.outcomeName ?? "—"}</div>
                                <div className="text-right">
                                  ${fmtNotional(notional)}
                                </div>
                              </div>
                              <div className="mt-1 grid grid-cols-2">
                                <div className="text-slate-300/50 text-xs">
                                  AVG ENTRY / EXIT
                                </div>
                                <div className="text-slate-300/50 text-xs text-right group relative">
                                  REALIZED P&L
                                  {typeof (p as any).feesPaid === "number" && (
                                    <div className="absolute right-0 bottom-full mb-1 hidden group-hover:block bg-emerald-900 text-slate-300 px-2 py-1 text-xs whitespace-nowrap z-10">
                                      FEES: ${fmtNotional((p as any).feesPaid)}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  <span>${fmtPrice(entryPrice)}</span>
                                  <span>/</span>
                                  <span className={exitCls}>
                                    ${fmtPrice(exitPrice)}
                                  </span>
                                </div>
                                <div
                                  className={`text-right ${clsNumber(realized)}`}
                                >
                                  {typeof realized === "number"
                                    ? `${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}`
                                    : "—"}
                                </div>
                              </div>
                              <div className="mt-1 flex justify-between">
                                <div className="mt-1 text-slate-300/50 text-xs">
                                  CLOSED
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {closedPagination && (
                          <PaginationNav
                            current={closedPage}
                            totalPages={totalClosedPages}
                            onChange={(page) => onClosedPageChange(a.id, page)}
                            className="mt-2 flex flex-wrap items-center justify-center gap-2 text-[11px]"
                            stopPropagation
                          />
                        )}
                      </>
                    )}
                    <div className="flex px-2 sm:px-4 py-1 items-center justify-between border-b-[1.5px] border-emerald-400/10 text-xs">
                      <div>
                        CASH:{" "}
                        {port
                          ? `$${fmtNotional(port.cashBalance ?? 0)}`
                          : spinGlyph}
                      </div>
                      <button
                        className="text-slate-400 hover:text-slate-100 hover:underline underline-offset-4 cursor-pointer"
                        onClick={() => onToggleShowClosed(a.id)}
                      >
                        {isShowClosed(a.id)
                          ? `[ HIDE CLOSED ]`
                          : `[ SHOW CLOSED ]`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}
