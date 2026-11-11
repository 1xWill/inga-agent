"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatRelativeTime, formatSmartTime } from "../../src/lib/time";
import Chart from "./chart";
import { DashboardAutoRefresh } from "./dashboard-auto-refresh";
import { AgentStrip } from "./dashboard/agent-strip";
import { PositionsPanel } from "./dashboard/positions-panel";
import { ActivitiesPanel } from "./dashboard/activities-panel";
import { EvaluationsPanel } from "./dashboard/evaluations-panel";
import {
  fmtNotional,
  fmtPnl,
  fmtPrice,
  fmtSignedUsd,
  clsNumber,
} from "./dashboard/utils";
import { buildPositionsByAgent, resolveFocusLabel } from "./dashboard/derive";
import type {
  ActivityItem,
  ClosedPositionsPage,
  FillView,
  MarketEvaluationView,
  PortfolioView,
  PositionView,
} from "../../src/types/dashboard";

interface DashboardClientProps {
  agents: Array<{
    id: string;
    label: string;
    logo?: string;
    chartStyle?: { color?: string; glyph?: string };
    address?: string;
  }>;
  initialData: {
    evaluations: {
      rows: MarketEvaluationView[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        maxPages: number;
      };
    };
    activities: {
      rows: ActivityItem[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        maxPages: number;
      };
    };
    fills: FillView[];
    portfolios: Record<string, PortfolioView>;
    ui?: { openPageSize: number; maxOpenPages: number };
  };
  refreshIntervalMs: number;
  chart: {
    cfg: {
      portfolio: { initialBalance: number; baseCurrency: string };
      charts: {
        yTicks: number;
        yPaddingPct: number;
        glyphsPerSeries?: number;
        endLabel?: { minGapPx: number };
        timeFormat?: { short: string; long: string };
      };
      portfolioHistory: { intervalMinutes: number };
    };
    history: {
      history: Record<string, Array<{ t: number; equity: number }>>;
      baselineStart?: { t: number; equity: number };
    };
    range: "all" | "72h";
  };
  state: {
    agentFocus: string | null;
    focusKey: string | null;
    showDecisions: boolean;
    showRejected: boolean;
    closedAgents: string[];
    closedPages: Record<string, ClosedPositionsPage | undefined>;
  };
}

export function DashboardClient({
  agents,
  initialData,
  refreshIntervalMs,
  chart,
  state,
}: DashboardClientProps) {
  const openPageSize = initialData.ui?.openPageSize ?? 10;
  const maxOpenPages = initialData.ui?.maxOpenPages ?? 8;
  const router = useRouter();
  const searchParams = useSearchParams();

  const portfolios = initialData.portfolios ?? {};
  const fills = initialData.fills ?? [];
  const evaluationsPage = initialData.evaluations;
  const activitiesPage = initialData.activities;
  const agentFocus = state.agentFocus;
  const focusKey = state.focusKey;
  const showDecisions = state.showDecisions;
  const showRejected = state.showRejected;
  const closedAgents = state.closedAgents ?? [];
  const closedPages = state.closedPages ?? {};
  const showMoreSummary = false;
  const [now, setNow] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<
    "positions" | "activities" | "evaluations"
  >("positions");
  const [mobileView, setMobileView] = useState<"positions" | "chart">(
    "positions",
  );
  const [pnlMode, setPnlMode] = useState<"total" | "realized" | "unrealized">(
    "total",
  );
  const showClosedByAgent = useMemo(() => new Set(closedAgents), [closedAgents]);
  const loadingClosedByAgent = useMemo(() => new Set<string>(), []);

  const [spinTick, setSpinTick] = useState(0);
  const SPIN_CHARS = ["/", "—", "\\", "|"] as const;
  const spinGlyph = SPIN_CHARS[spinTick % 4];

  const [markBasis, setMarkBasis] = useState<"ask" | "bid">(() => {
    if (typeof window !== "undefined") {
      const v = window.localStorage.getItem("inga.markBasis");
      if (v === "bid" || v === "ask") return v;
    }
    return "ask";
  });
  useEffect(() => {
    try {
      if (typeof window !== "undefined")
        window.localStorage.setItem("inga.markBasis", markBasis);
    } catch {}
  }, [markBasis]);
  const positionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(
    new Set(),
  );
  const [openPageByAgent, setOpenPageByAgent] = useState<Map<string, number>>(
    new Map(),
  );
  useEffect(() => {
    setOpenPageByAgent(new Map());
  }, [focusKey]);
  // Filtering is controlled by header agent card (agentFocus)
  const focusParts = useMemo(() => {
    if (!focusKey) return { marketId: undefined, optionId: undefined };
    if (focusKey.includes(":")) {
      const [mId, oId] = focusKey.split(":");
      return { marketId: mId, optionId: oId };
    }
    return { marketId: focusKey, optionId: undefined };
  }, [focusKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setSpinTick((t) => t + 1), 150);
    return () => clearInterval(id);
  }, []);

  const agentLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.label);
    return m;
  }, [agents]);

  const agentLogoById = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const a of agents) m.set(a.id, a.logo);
    return m;
  }, [agents]);

  const marketUrlById = useMemo(() => {
    const m = new Map<string, string>();
    for (const market of evaluationsPage.rows ?? []) {
      if (market.marketId && market.url) {
        m.set(market.marketId, market.url);
      }
    }
    return m;
  }, [evaluationsPage.rows]);

  const pushQuery = useCallback(
    (mutate: (sp: URLSearchParams) => void) => {
      const sp = new URLSearchParams(searchParams.toString());
      mutate(sp);
      const qs = sp.toString();
      router.push(qs ? `?${qs}` : `?`, { scroll: false });
    },
    [router, searchParams],
  );

  const setAgentFocusParam = useCallback(
    (next: string | null) => {
      pushQuery((sp) => {
        if (next) sp.set("agent", next);
        else sp.delete("agent");
        sp.set("ep", "1");
        sp.set("ap", "1");
      });
    },
    [pushQuery],
  );

  const setFocusParam = useCallback(
    (next: string | null) => {
      pushQuery((sp) => {
        if (next) sp.set("focus", next);
        else sp.delete("focus");
        sp.set("ep", "1");
        sp.set("ap", "1");
      });
    },
    [pushQuery],
  );

  const setChartRangeParam = useCallback(
    (next: "all" | "72h") => {
      pushQuery((sp) => {
        sp.set("range", next);
      });
    },
    [pushQuery],
  );

  const setShowDecisionsParam = useCallback(
    (next: boolean) => {
      pushQuery((sp) => {
        sp.set("decisions", next ? "1" : "0");
        sp.set("ap", "1");
      });
    },
    [pushQuery],
  );

  const setShowRejectedParam = useCallback(
    (next: boolean) => {
      pushQuery((sp) => {
        sp.set("rejected", next ? "1" : "0");
        sp.set("ep", "1");
      });
    },
    [pushQuery],
  );

  const setEvaluationPageParam = useCallback(
    (page: number) => {
      pushQuery((sp) => {
        sp.set("ep", String(page));
      });
    },
    [pushQuery],
  );

  const setActivityPageParam = useCallback(
    (page: number) => {
      pushQuery((sp) => {
        sp.set("ap", String(page));
      });
    },
    [pushQuery],
  );

  const toggleClosedAgentParam = useCallback(
    (agentId: string) => {
      pushQuery((sp) => {
        const existing = (sp.get("closed") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const set = new Set(existing);
        if (set.has(agentId)) {
          set.delete(agentId);
          sp.delete(`closedPage_${agentId}`);
        } else {
          set.add(agentId);
          sp.set(`closedPage_${agentId}`, "1");
        }
        const next = Array.from(set);
        if (next.length === 0) sp.delete("closed");
        else sp.set("closed", next.join(","));
      });
    },
    [pushQuery],
  );

  const setClosedPageParam = useCallback(
    (agentId: string, page: number) => {
      pushQuery((sp) => {
        sp.set(`closedPage_${agentId}`, String(page));
      });
    },
    [pushQuery],
  );

  const formatRelTime = useCallback(
    (iso: string | undefined) => formatRelativeTime(now, iso),
    [now],
  );
  const formatRelOrLocal = useCallback(
    (iso: string | undefined) => formatSmartTime(now, iso),
    [now],
  );

  // Pagination and filters are URL-driven; the server renders fresh data on navigation,
  // and a client-side `router.refresh()` keeps it updated without any /api/* calls.

  const isShowClosed = useCallback(
    (agentId: string) => showClosedByAgent.has(agentId),
    [showClosedByAgent],
  );
  const toggleShowClosed = useCallback(
    (agentId: string) => {
      toggleClosedAgentParam(agentId);
    },
    [toggleClosedAgentParam],
  );
  const handleClosedPageChange = useCallback(
    (agentId: string, page: number) => {
      setClosedPageParam(agentId, page);
    },
    [setClosedPageParam],
  );

  // no UI fallback mapping — rely on server enrichment only

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const applyFocus = (marketId?: string, outcomeId?: string) => {
    const key = outcomeId ? `${marketId}:${outcomeId}` : marketId;
    if (!key) {
      setFocusParam(null);
      return;
    }
    if (focusKey === key) {
      setFocusParam(null);
    } else {
      setFocusParam(key);
      const ref = positionRefs.current.get(key);
      if (ref) ref.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const closedRowsByAgent = useMemo(() => {
    const map: Record<string, PositionView[]> = {};
    const [focusMarket, focusOutcome] = (() => {
      if (!focusKey) return [undefined, undefined] as const;
      if (focusKey.includes(":")) {
        const [mId, oId] = focusKey.split(":");
        return [mId, oId] as const;
      }
      return [focusKey, undefined] as const;
    })();
    for (const [agentId, page] of Object.entries(closedPages)) {
      if (!page?.rows) continue;
      const filters = page.filters ?? {};
      const matchesFocus =
        (focusMarket ?? undefined) === (filters.marketId ?? undefined) &&
        (focusOutcome ?? undefined) === (filters.optionId ?? undefined);
      if (matchesFocus) {
        map[agentId] = page.rows;
      }
    }
    return map;
  }, [closedPages, focusKey]);

  const positionsByAgent = useMemo(
    () =>
      buildPositionsByAgent(agents, portfolios, focusKey, closedRowsByAgent),
    [agents, portfolios, focusKey, closedRowsByAgent],
  );

  const focusLabel = useMemo(
    () =>
      resolveFocusLabel(
        focusKey,
        portfolios,
        evaluationsPage.rows ?? [],
        activitiesPage.rows ?? [],
      ),
    [focusKey, portfolios, evaluationsPage.rows, activitiesPage.rows],
  );
  const toggleMarkBasis = () =>
    setMarkBasis((m) => (m === "ask" ? "bid" : "ask"));
  const togglePnlMode = () =>
    setPnlMode((m) =>
      m === "total" ? "realized" : m === "realized" ? "unrealized" : "total",
    );
  const handleToggleCollapsed = (agentId: string) => {
    setCollapsedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };
  const handleOpenPageChange = (agentId: string, page: number) => {
    setOpenPageByAgent((prev) => {
      const next = new Map(prev);
      next.set(agentId, page);
      return next;
    });
  };

  const markBasisTitle =
    markBasis === "bid"
      ? "Switch to MARK (uses best ask)"
      : "Switch to MARK (BEST BID)";
  const markToggleLabel = markBasis === "bid" ? "MARK (BEST BID)" : "MARK";

  const activityVisible = activitiesPage.rows ?? [];

  const evaluationsVisible = evaluationsPage.rows ?? [];

  return (
    <div className="flex flex-col h-full min-h-0 pb-14 md:pb-0">
      <DashboardAutoRefresh intervalMs={refreshIntervalMs} />
      <nav className="flex items-center justify-between border-b-[1.5px] border-emerald-400 px-4 py-4">
        <div className="font-semibold px-5">
          {/* Brand: show full logo on md+ screens, fallback to favicon on small screens */}
          <span className="inline-flex items-center">
            {/* Small screens: favicon */}
            <Image
              src="/favicon.ico"
              alt="INGA"
              width={32}
              height={32}
              unoptimized
              className="mt-1 block md:hidden"
            />
            {/* md+ screens: full brand mark */}
            <Image
              src="/logos/inga-brand.png"
              alt="INGA"
              width={120}
              height={28}
              unoptimized
              className="mt-1 hidden md:block"
            />
          </span>
        </div>
      </nav>

      <AgentStrip
        agents={agents}
        portfolios={portfolios}
        agentFocus={agentFocus}
        onFocusChange={setAgentFocusParam}
        spinGlyph={spinGlyph}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden flex-col md:flex-row [&_*]:transition [&_*]:duration-200 [&_*]:ease-in-out">
        <div
          className={`${mobileView === "chart" ? "hidden" : "flex"} md:flex flex-col border-b-[1.5px] md:border-b-0 md:border-r-[1.5px] border-emerald-400 min-h-0 w-full md:w-[480px] md:max-w-[560px] flex-none`}
        >
          <div className="flex gap-0 border-b-[1.5px] border-emerald-400">
            {[
              { key: "positions", label: "POSITIONS" },
              { key: "activities", label: "ACTIVITIES" },
              { key: "evaluations", label: "EVALUATIONS" },
            ].map((t) => (
              <button
                key={t.key}
                className={`flex-1 text-sm uppercase font-semibold tracking-wide px-2.5 py-1.5 border-r-[1.5px] border-emerald-400 last:border-r-0 cursor-pointer ${activeTab === (t.key as any) ? "bg-emerald-400/100 text-slate-200" : "text-slate-200 hover:text-emerald-400"}`}
                onClick={() => setActiveTab(t.key as any)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab !== "positions" && (
            <div className="px-2 sm:px-4 flex gap-2 items-center text-xs sm:text-sm">
              {agentFocus && (
                <span
                  className="inline-block px-2 py-0.5 mt-2 border-[1.5px] border-emerald-400/40 hover:border-emerald-400 hover:text-emerald-400 cursor-pointer"
                  onClick={() => setAgentFocusParam(null)}
                  title="Clear agent focus"
                >
                  {agentLabelById.get(agentFocus) ?? agentFocus} ✕
                </span>
              )}
              {focusKey && (
                <span
                  className="inline-block px-2 py-0.5 mt-2 border-[1.5px] border-emerald-400/40 hover:border-emerald-400 hover:text-emerald-400 cursor-pointer"
                  onClick={() => setFocusParam(null)}
                  title="Clear focus"
                >
                  <span className="truncate" title={focusLabel}>
                    {focusLabel}
                  </span>{" "}
                  ✕
                </span>
              )}
            </div>
          )}

          {activeTab === "positions" && (
            <PositionsPanel
              agents={agents}
              portfolios={portfolios}
              fills={fills}
              positionsByAgent={positionsByAgent}
              agentFocus={agentFocus}
              focusKey={focusKey}
              focusLabel={focusLabel}
              onClearAgentFocus={() => setAgentFocusParam(null)}
              onClearFocus={() => setFocusParam(null)}
              onApplyFocus={applyFocus}
              markBasis={markBasis}
              onToggleMarkBasis={toggleMarkBasis}
              pnlMode={pnlMode}
              onTogglePnlMode={togglePnlMode}
              collapsedAgents={collapsedAgents}
              onToggleCollapsed={handleToggleCollapsed}
              showClosedByAgent={showClosedByAgent}
              loadingClosedByAgent={loadingClosedByAgent}
              onToggleShowClosed={toggleShowClosed}
              onClosedPageChange={handleClosedPageChange}
              isShowClosed={isShowClosed}
              closedPages={closedPages}
              formatRelTime={formatRelTime}
              agentLabelById={agentLabelById}
              spinGlyph={spinGlyph}
              markBasisTitle={markBasisTitle}
              markToggleLabel={markToggleLabel}
              positionRefs={positionRefs}
              openPageSize={openPageSize}
              maxOpenPages={maxOpenPages}
              openPageByAgent={openPageByAgent}
              onOpenPageChange={handleOpenPageChange}
            />
          )}

          {activeTab === "activities" && (
            <ActivitiesPanel
              items={activityVisible}
              pagination={activitiesPage.pagination}
              agentFocus={agentFocus}
              agentLabelById={agentLabelById}
              agentLogoById={agentLogoById}
              showDecisions={showDecisions}
              onToggleDecisions={() => setShowDecisionsParam(!showDecisions)}
              onPageChange={setActivityPageParam}
              formatRelTime={formatRelTime}
              onApplyFocus={applyFocus}
              expandedRows={expandedRows}
              onToggleRow={toggleRow}
              focusKey={focusKey}
              spinGlyph={spinGlyph}
              marketUrlById={marketUrlById}
            />
          )}

          {activeTab === "evaluations" && (
            <EvaluationsPanel
              items={evaluationsVisible}
              pagination={evaluationsPage.pagination}
              agentFocus={agentFocus}
              agentLabelById={agentLabelById}
              agentLogoById={agentLogoById}
              showRejected={showRejected}
              onToggleRejected={() => setShowRejectedParam(!showRejected)}
              onPageChange={setEvaluationPageParam}
              formatRelOrLocal={formatRelOrLocal}
              onApplyFocus={(marketId?: string) => applyFocus(marketId)}
              expandedRows={expandedRows}
              onToggleRow={toggleRow}
              focusKey={focusKey}
            />
          )}
        </div>

        <div
          className={`${mobileView === "positions" ? "hidden" : "flex"} md:flex flex-col min-h-0 flex-1 min-w-0`}
        >
          <div className="flex-1 min-h-0 overflow-auto">
            <Chart
              agents={agents as any}
              portfolios={portfolios}
              cfg={chart.cfg as any}
              history={chart.history as any}
              range={chart.range}
              onRangeChange={setChartRangeParam}
            />
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t-[1.5px] border-emerald-400 bg-black md:hidden">
        <div className="flex gap-0">
          {[
            { key: "positions", label: "POSITIONS" },
            { key: "chart", label: "CHART" },
          ].map((t) => (
            <button
              key={t.key}
              className={`flex-1 text-xs uppercase font-semibold tracking-wide px-2.5 py-2 border-r-[1.5px] border-emerald-400 last:border-r-0 cursor-pointer ${
                mobileView === (t.key as "positions" | "chart")
                  ? "bg-emerald-400/100 text-slate-200"
                  : "text-slate-200 hover:text-emerald-400"
              }`}
              onClick={() => setMobileView(t.key as "positions" | "chart")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
