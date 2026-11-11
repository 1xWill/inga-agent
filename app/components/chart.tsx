"use client";

import React, {
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
type Agent = {
  id: string;
  label: string;
  logo?: string;
  chartStyle: { color: string; glyph: string };
};
type PortfolioMap = Record<string, { equity?: number } & Record<string, any>>;

type ConfigPublic = {
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

type HistoryPoint = { t: number; equity: number };
type BaselineStartPoint = { t: number; equity: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function linspace(n: number, start: number, end: number) {
  return Array.from({ length: n }, (_, i) =>
    n === 1 ? start : start + (i / (n - 1)) * (end - start),
  );
}
function fmtTime(ts: number) {
  const d = new Date(ts);
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${day} ${hh}:${mm}`;
}

// Linear interpolation on time to a fixed-length vector
// Map real samples to a fixed-length series of glyphs.
// - Ensures exactly N glyphs per series, with at most one real glyph per bin.
// - Fills empty bins with linearly-interpolated ghost glyphs.
function densifyToFixedGlyphs(
  points: HistoryPoint[],
  N: number,
  tMin: number,
  tMax: number,
): { values: number[]; isReal: boolean[] } {
  const values = new Array<number>(Math.max(1, N)).fill(0);
  const isReal = new Array<boolean>(Math.max(1, N)).fill(false);
  if (N <= 1) {
    if (points.length) values[0] = points[points.length - 1].equity;
    return { values, isReal };
  }
  if (points.length === 0 || tMax <= tMin) return { values, isReal };

  // Precompute bin centers in time
  const binCenterTs = linspace(N, tMin, tMax);
  // Assign each real point to its nearest bin (round to nearest center); keep the closest one per bin
  const chosenRawIdxByBin: Array<number | null> = new Array(N).fill(null);
  for (let k = 0; k < points.length; k++) {
    const pt = points[k];
    const pos = (pt.t - tMin) / (tMax - tMin);
    const b = clamp(Math.round(pos * (N - 1)), 0, N - 1);
    const curr = chosenRawIdxByBin[b];
    if (curr === null) {
      chosenRawIdxByBin[b] = k;
    } else {
      // prefer the one closer to bin center
      const currDist = Math.abs(points[curr].t - binCenterTs[b]);
      const newDist = Math.abs(pt.t - binCenterTs[b]);
      if (newDist < currDist) chosenRawIdxByBin[b] = k;
    }
  }

  // Two-pointer for interpolation between bracketing real samples (in raw space)
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = binCenterTs[i];
    // if this bin has a chosen real raw sample, use it
    const chosenIdx = chosenRawIdxByBin[i];
    if (chosenIdx !== null) {
      values[i] = points[chosenIdx].equity;
      isReal[i] = true;
      // move j up to the left of t for subsequent interpolation steps
      while (j + 1 < points.length && points[j + 1].t <= t) j++;
      continue;
    }

    // Interpolate ghost glyph from surrounding real points
    while (j + 1 < points.length && points[j + 1].t <= t) j++;
    const left = points[j];
    const right = points[Math.min(j + 1, points.length - 1)];
    if (right.t === left.t) {
      values[i] = left.equity;
    } else {
      const a = (t - left.t) / (right.t - left.t);
      values[i] = left.equity * (1 - a) + right.equity * a;
    }
  }
  return { values, isReal };
}

export default function Chart({
  agents,
  portfolios,
  cfg,
  history,
  range,
  onRangeChange,
}: {
  agents: Agent[];
  portfolios: PortfolioMap;
  cfg: ConfigPublic;
  history: {
    history: Record<string, Array<{ t: number; equity: number }>>;
    baselineStart?: { t: number; equity: number };
  };
  range: "all" | "72h";
  onRangeChange: (next: "all" | "72h") => void;
}) {
  const [mode, setMode] = useState<"portfolio" | "pnl">("portfolio");
  const [hover, setHover] = useState<{ id: string | null; i: number | null }>({
    id: null,
    i: null,
  });
  const seriesByAgent = (history?.history ?? {}) as Record<string, HistoryPoint[]>;
  const baselineStart = (history?.baselineStart ?? null) as BaselineStartPoint | null;
  // NOTE: Avoid complex animation state to keep chart stable; we'll use CSS transforms for subtle transitions.

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [height, setHeight] = useState(360);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver((ents) => {
      for (const e of ents) {
        setWidth(Math.floor(e.contentRect.width));
        setHeight(Math.max(360, Math.floor(e.contentRect.height)));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Data is server-supplied. No client-side /api polling.

  // Derived numbers
  const initialBalance = cfg?.portfolio.initialBalance ?? 0;
  // Live-aware baseline for portfolio mode: earliest equity across agents in current window or current equity fallback
  const baselineRef = useMemo(() => {
    // 72H: keep baseline anchored to inception using real DB data.
    if (
      range === "72h" &&
      baselineStart &&
      typeof baselineStart.equity === "number"
    ) {
      return baselineStart.equity;
    }

    // ALL: baseline is already correct when derived from the displayed series start.
    const firsts: number[] = [];
    for (const id of Object.keys(seriesByAgent)) {
      const arr = seriesByAgent[id] || [];
      if (arr.length) firsts.push(arr[0].equity);
    }
    if (firsts.length) return Math.min(...firsts);
    const nowVals: number[] = Object.values(portfolios || {})
      .map((p: any) => (typeof p?.equity === "number" ? p.equity : NaN))
      .filter((n) => Number.isFinite(n)) as number[];
    if (nowVals.length) return Math.min(...nowVals);
    return initialBalance;
  }, [range, baselineStart, seriesByAgent, portfolios, initialBalance]);
  const yTicks = cfg?.charts.yTicks ?? 6;
  const yPadPct = cfg?.charts.yPaddingPct ?? 0.1;
  const glyphsPerSeries = cfg?.charts.glyphsPerSeries ?? 160;
  // Glyph font sizes
  const dotFontSize = 12;
  const hoverDotFontSize = 20;

  // Layout paddings (dynamic bottom to keep x-axis close to bottom and allow rotated labels on small widths)
  const rotateXLabels = width < 700; // rotate labels when the chart gets narrow
  const pad = useMemo(
    () => ({ top: 10, right: 64, bottom: rotateXLabels ? 64 : 24, left: 60 }),
    [rotateXLabels],
  );
  // Build resampled values for display per agent, aligned to width-derived sample count
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = Math.max(0, height - pad.top - pad.bottom);
  const nowTs = Date.now();
  const timeMin = useMemo(() => {
    // Determine earliest sample across all agents
    const mins = Object.values(seriesByAgent)
      .flat()
      .map((p) => p.t);
    const earliest = mins.length ? Math.min(...mins) : Number.POSITIVE_INFINITY;
    if (range === "72h") {
      const winStart = nowTs - 72 * 3600 * 1000;
      // If earliest is within the last 72h, start from earliest; otherwise use 72h window start
      if (earliest !== Number.POSITIVE_INFINITY && earliest >= winStart)
        return earliest;
      return winStart;
    }
    // ALL range: start from earliest sample when available; fallback to 24h window
    return earliest !== Number.POSITIVE_INFINITY
      ? earliest
      : nowTs - 24 * 3600 * 1000;
  }, [seriesByAgent, range, nowTs]);
  const targetLen = Math.max(2, glyphsPerSeries);
  const xs = linspace(targetLen, pad.left, pad.left + innerW);

  const seriesDots = useMemo(() => {
    const out: Record<string, { values: number[]; isReal: boolean[] }> = {};
    for (const a of agents) {
      const raw = (seriesByAgent[a.id] || []).map((p) => ({
        t: p.t,
        equity: p.equity,
      }));
      // append a final NOW point with live equity for consistency with cards
      const liveEq = portfolios?.[a.id]?.equity;
      if (typeof liveEq === "number") raw.push({ t: nowTs, equity: liveEq });
      const sorted = raw.sort((x, y) => x.t - y.t);
      const densified = densifyToFixedGlyphs(sorted, targetLen, timeMin, nowTs);
      // Per-agent PnL baseline: earliest available equity in the window
      const baseline =
        sorted.length > 0 ? sorted[0].equity : initialBalance;
      const values =
        mode === "portfolio"
          ? densified.values
          : densified.values.map(
              (v) => ((v - baseline) / (baseline || 1)) * 100,
            );
      out[a.id] = { values, isReal: densified.isReal };
    }
    return out;
  }, [
    agents,
    seriesByAgent,
    targetLen,
    timeMin,
    nowTs,
    mode,
    initialBalance,
    portfolios,
  ]);

  // y domain with better range calculation
  const allVals = Object.values(seriesDots)
    .map((o) => o.values)
    .flat();
  let vMin = allVals.length ? Math.min(...allVals) : 0;
  let vMax = allVals.length ? Math.max(...allVals) : 1;
  if (mode === "portfolio") {
    vMin = Math.min(vMin, baselineRef);
    vMax = Math.max(vMax, baselineRef);
  } else {
    vMin = Math.min(vMin, 0);
    vMax = Math.max(vMax, 0);
  }

  // Calculate range with larger steps for better visibility
  const dataRange = vMax - vMin;
  let padAmt: number;

  if (mode === "portfolio") {
    // For portfolio mode: use minimum 2% padding or larger based on data range
    const minPadPct = 0.02; // 2% minimum
    const dynamicPadPct = Math.max(minPadPct, yPadPct);
    padAmt = Math.max(dataRange * dynamicPadPct, baselineRef * 0.02);

    // Round padding to nice numbers for portfolio values
    if (padAmt < 50) padAmt = 50;
    else if (padAmt < 100) padAmt = Math.ceil(padAmt / 10) * 10;
    else if (padAmt < 500) padAmt = Math.ceil(padAmt / 50) * 50;
    else padAmt = Math.ceil(padAmt / 100) * 100;
  } else {
    // For % mode: use similar logic but with % values
    const minPadPct = 0.5; // 0.5% minimum padding
    padAmt = Math.max(dataRange * yPadPct, minPadPct);

    // Round to nice % values
    if (padAmt < 1) padAmt = 1;
    else if (padAmt < 5) padAmt = Math.ceil(padAmt);
    else padAmt = Math.ceil(padAmt / 2) * 2;
  }

  const yMin = vMin - padAmt;
  const yMax = vMax + padAmt;
  const yScale = (v: number) =>
    pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  return (
    <div ref={wrapRef} className="w-full h-full flex flex-col transition-all">
      {/* Controls */}
      <div className="flex px-4 py-1.5 items-center justify-between">
        <div className="flex border-1 border-emerald-400">
          <button
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wide cursor-pointer ${mode === "portfolio" ? "bg-emerald-400/90 text-slate-300" : "text-slate-300 hover:text-emerald-400"}`}
            onClick={() => setMode("portfolio")}
          >
            Portfolio $
          </button>
          <button
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wide cursor-pointer ${mode === "pnl" ? "bg-emerald-400/90 text-slate-300" : "text-slate-300 hover:text-emerald-400"}`}
            onClick={() => setMode("pnl")}
          >
            P&L %
          </button>
        </div>
        <div className="flex border-1 border-emerald-400">
          <button
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wide cursor-pointer ${range === "all" ? "bg-emerald-400/90 text-slate-300" : "text-slate-300 hover:text-emerald-400"}`}
            onClick={() => onRangeChange("all")}
          >
            All
          </button>
          <button
            className={`px-3 py-1 text-xs font-bold uppercase tracking-wide cursor-pointer ${range === "72h" ? "bg-emerald-400/90 text-slate-300" : "text-slate-300 hover:text-emerald-400"}`}
            onClick={() => onRangeChange("72h")}
          >
            72H
          </button>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0 p-3">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
          width="100%"
          height="100%"
          onMouseMove={(e) => {
            const svgEl = svgRef.current;
            if (!svgEl) return;
            const ctm = svgEl.getScreenCTM();
            if (!ctm) return;
            const px = e.clientX;
            const py = e.clientY;
            const R = 14; // hover radius in px
            let bestReal: { id: string; i: number; d2: number } | null = null;
            for (const a of agents) {
              const entry = seriesDots[a.id];
              if (!entry) continue;
              const vals = entry.values;
              const flags = entry.isReal;
              for (let i = 0; i < vals.length; i++) {
                if (!flags[i]) continue; // only consider real glyphs for hover
                const cxSvg = xs[i];
                const cySvg = yScale(vals[i]);
                // Map glyph center from SVG space to screen space using CTM
                const cx = ctm.a * cxSvg + ctm.c * cySvg + ctm.e;
                const cy = ctm.b * cxSvg + ctm.d * cySvg + ctm.f;
                const dx = cx - px;
                const dy = cy - py;
                const d2 = dx * dx + dy * dy;
                if (!bestReal || d2 < bestReal.d2)
                  bestReal = { id: a.id, i, d2 };
              }
            }
            if (bestReal && bestReal.d2 <= R * R)
              setHover({ id: bestReal.id, i: bestReal.i });
            else setHover({ id: null, i: null });
          }}
          onMouseLeave={() => setHover({ id: null, i: null })}
          style={{ display: "block", overflow: "visible" }}
        >
          <g>
            {/* axes */}
            <line
              x1={pad.left}
              x2={pad.left}
              y1={pad.top}
              y2={pad.top + innerH}
              stroke="#fff"
              strokeOpacity={0.6}
              strokeWidth={1}
            />
            <line
              x1={pad.left}
              x2={pad.left + innerW}
              y1={pad.top + innerH}
              y2={pad.top + innerH}
              stroke="#fff"
              strokeOpacity={0.6}
              strokeWidth={1}
            />

            {/* baseline reference lines */}
            {mode === "portfolio" && baselineRef > 0 && (
              <>
                <line
                  x1={pad.left}
                  x2={pad.left + innerW}
                  y1={yScale(baselineRef)}
                  y2={yScale(baselineRef)}
                  stroke="#fff"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                <text
                  x={pad.left - 8}
                  y={yScale(baselineRef)}
                  textAnchor="end"
                  fontSize={10}
                  fill="#fff"
                  fillOpacity={0.6}
                  dominantBaseline="middle"
                >
                  ${baselineRef}
                </text>
              </>
            )}
            {mode === "pnl" && (
              <>
                <line
                  x1={pad.left}
                  x2={pad.left + innerW}
                  y1={yScale(0)}
                  y2={yScale(0)}
                  stroke="#fff"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                <text
                  x={pad.left - 8}
                  y={yScale(0)}
                  textAnchor="end"
                  fontSize={10}
                  fill="#fff"
                  fillOpacity={0.6}
                  dominantBaseline="middle"
                >
                  0%
                </text>
              </>
            )}

            {/* y ticks */}
            {Array.from({ length: (yTicks ?? 6) + 1 }, (_, i) => {
              const t = i / (yTicks ?? 6);
              const v = yMax - t * (yMax - yMin);
              const y = clamp(pad.top + t * innerH, pad.top, pad.top + innerH);
              const label =
                mode === "portfolio"
                  ? `$${v.toFixed(0)}`
                  : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
              return (
                <text
                  key={i}
                  x={pad.left - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={12}
                  fill="#c3c3c3"
                >
                  {label}
                </text>
              );
            })}

            {/* x labels (responsive density + optional -45deg rotation on narrow widths) */}
            {(() => {
              const axisY = pad.top + innerH;
              // Decide how many segments based on available width and a minimum pixel spacing
              const minSpacing = rotateXLabels ? 84 : 110; // slightly tighter when rotated
              const maxSegments = 6; // keep <= previous default
              const segments = Math.max(
                2,
                Math.min(maxSegments, Math.floor(innerW / minSpacing)),
              );
              const labels: React.ReactElement[] = [];
              for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const ts = timeMin + t * (nowTs - timeMin);
                const x = pad.left + t * innerW;
                if (rotateXLabels) {
                  const y = axisY + 10; // base position below axis
                  labels.push(
                    <text
                      key={`x-${i}`}
                      x={x}
                      y={y}
                      textAnchor="end"
                      dx="-0.4em"
                      dy="0.71em"
                      fontSize={11}
                      fill="#c3c3c3"
                      transform={`rotate(-45 ${x} ${y})`}
                    >
                      {fmtTime(i === segments ? nowTs : ts)}
                    </text>,
                  );
                } else {
                  const y = axisY + 12;
                  const anchor = i === 0 ? "start" : i === segments ? "end" : "middle";
                  labels.push(
                    <text
                      key={`x-${i}`}
                      x={x}
                      y={y}
                      textAnchor={anchor}
                      fontSize={11}
                      fill="#c3c3c3"
                    >
                      {fmtTime(i === segments ? nowTs : ts)}
                    </text>,
                  );
                }
              }
              return labels;
            })()}

            {/* series glyphs */}
            {agents.map((a) => {
              const entry = seriesDots[a.id];
              const vals = entry?.values || [];
              const flags = entry?.isReal || [];
              const color = a.chartStyle.color;
              const glyph = a.chartStyle.glyph;
              const opacity = hover.id && hover.id !== a.id ? 0.25 : 1;
              return (
                <g key={a.id} opacity={opacity}>
                  {vals.map((v, i) => {
                    const isReal = flags[i] === true;
                    return (
                      <text
                        key={i}
                        x={xs[i]}
                        y={yScale(v)}
                        fontSize={dotFontSize}
                        fill={color}
                        fillOpacity={isReal ? 1 : 0.35}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        style={{ pointerEvents: "none" }}
                      >
                        {glyph}
                      </text>
                    );
                  })}
                </g>
              );
            })}

            {/* hover emphasis and label */}
            {hover.id &&
              hover.i !== null &&
              (() => {
                const a = agents.find((x) => x.id === hover.id)!;
                const entry = seriesDots[a.id];
                const vals = entry?.values || [];
                const flags = entry?.isReal || [];
                if (!vals.length) return null;
                // Snap to nearest visible real glyph
                let j = hover.i!;
                if (!flags[j]) {
                  let left = j - 1;
                  let right = j + 1;
                  let found: number | null = null;
                  while (left >= 0 || right < vals.length) {
                    if (left >= 0 && flags[left]) {
                      found = left;
                      break;
                    }
                    if (right < vals.length && flags[right]) {
                      found = right;
                      break;
                    }
                    left--;
                    right++;
                  }
                  if (found !== null) j = found;
                }
                if (!flags[j]) return null; // no real points to show label
                const v = vals[j];
                const color = a.chartStyle.color;
                const glyph = a.chartStyle.glyph;
                const x = xs[j];
                const y = yScale(v);
                const label = `${a.label}: ${mode === "portfolio" ? `$${v.toFixed(0)}` : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}`;
                return (
                  <g>
                    <text
                      x={x}
                      y={y}
                      fontSize={hoverDotFontSize}
                      fill={color}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="cursor-pointer"
                    >
                      {glyph}
                    </text>
                    <text
                      x={x - 100}
                      y={y - 20}
                      fontSize={14}
                      fill={color}
                      textAnchor="start"
                      dominantBaseline="middle"
                    >
                      {label}
                    </text>
                  </g>
                );
              })()}

            {/* end labels: logo · number */}
            {agents.map((a) => {
              const vals = seriesDots[a.id]?.values || [];
              if (!vals.length) return null;
              const last = vals[vals.length - 1];
              const y = yScale(last);
              const color = a.chartStyle.color;
              const isActive = hover.id === a.id;
              const label =
                mode === "portfolio"
                  ? `$${last.toFixed(0)}`
                  : `${last >= 0 ? "+" : ""}${last.toFixed(1)}%`;
              const x = pad.left + innerW + 6;
              return (
                <g key={`end-${a.id}`} opacity={isActive ? 1 : 0.45}>
                  {a.logo && (
                    <image
                      href={a.logo}
                      x={x + 4}
                      y={y - 10}
                      width={20}
                      height={20}
                      preserveAspectRatio="xMidYMid slice"
                    />
                  )}
                  <text
                    x={x + (a.logo ? 18 : 0) + 8}
                    y={y + 1}
                    fontSize={14}
                    fill={color}
                    textAnchor="start"
                    dominantBaseline="middle"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
