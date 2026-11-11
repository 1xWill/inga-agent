"use client";

import Image from "next/image";
import type { PortfolioView } from "../../../src/types/dashboard";
import { fmtNotional } from "./utils";

type Agent = {
  id: string;
  label: string;
  logo?: string;
  chartStyle?: { color?: string; glyph?: string };
  address?: string;
};

type AgentStripProps = {
  agents: Agent[];
  portfolios: Record<string, PortfolioView>;
  agentFocus: string | null;
  onFocusChange: (next: string | null) => void;
  spinGlyph: string;
};

const computeEquity = (port?: PortfolioView): number | null => {
  if (!port) return null;
  if (typeof port.equity === "number") return port.equity;
  const open = (port.positions ?? []).filter((p) => p.status === "open");
  const positionsValue = open.reduce((acc, p) => {
    const mark =
      typeof p.bestBid === "number"
        ? p.bestBid
        : typeof p.bestAsk === "number"
          ? p.bestAsk
          : p.averagePrice;
    return acc + mark * p.quantity;
  }, 0);
  return (port.cashBalance ?? 0) + positionsValue;
};

export function AgentStrip({
  agents,
  portfolios,
  agentFocus,
  onFocusChange,
  spinGlyph,
}: AgentStripProps) {
  return (
    <section className="border-b-[1.5px] border-emerald-400 [&_*]:transition [&_*]:duration-200 [&_*]:ease-in-out">
      <div className="flex flex-wrap gap-1 sm:gap-2">
        {agents.map((a) => {
          const port = portfolios[a.id];
          const equity = computeEquity(port);
          const focused = agentFocus === a.id;
          return (
            <button
              type="button"
              key={a.id}
              className={`flex-1 min-w-[6rem] group text-center ${focused ? "bg-emerald-400/40" : ""} px-1.5 py-1 sm:p-2 cursor-pointer`}
              onClick={() => onFocusChange(focused ? null : a.id)}
              title={
                focused ? "Unfocus agent" : "Focus this agent across tabs"
              }
            >
              <div className="text-[10px] sm:text-xs text-slate-300 group-hover:text-emerald-400 flex items-center justify-center gap-1 sm:gap-2 leading-tight">
                {a.logo && (
                  <Image
                    src={a.logo}
                    alt={a.label}
                    width={16}
                    height={16}
                    className="w-3 h-3 sm:w-4 sm:h-4 rounded"
                  />
                )}
                <span>{a.label}</span>
                {a.address && (
                  <a
                    href={`https://polygonscan.com/address/${a.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-slate-300/50 hover:text-slate-100 ml-1"
                    onClick={(e) => e.stopPropagation()}
                    title="Open on Polygonscan"
                  >
                    ↗
                  </a>
                )}
              </div>
              <div className="text-xs sm:text-sm md:text-base">
                {typeof equity === "number" ? `$${fmtNotional(equity)}` : spinGlyph}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
