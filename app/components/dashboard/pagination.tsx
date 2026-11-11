"use client";

export function buildPageList(
  current: number,
  total: number,
): Array<number | "…"> {
  if (total <= 1) return [1];
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let i = current - 2; i <= current + 2; i += 1) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const result: Array<number | "…"> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push("…");
    result.push(sorted[i]);
  }
  return result;
}

type PaginationNavProps = {
  current: number;
  totalPages: number;
  onChange: (page: number) => void;
  className?: string;
  stopPropagation?: boolean;
};

export function PaginationNav({
  current,
  totalPages,
  onChange,
  className = "",
  stopPropagation = false,
}: PaginationNavProps) {
  if (totalPages <= 1) return null;
  const entries = buildPageList(current, totalPages);
  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-2 text-[11px] mt-2 mb-2 ${className}`}
    >
      {entries.map((entry, idx) =>
        entry === "…" ? (
          <span
            key={`pg-ellipsis-${idx}`}
            className="px-2 text-slate-400 select-none"
          >
            …
          </span>
        ) : (
          <button
            key={`pg-${entry}`}
            className={`px-2 py-0.5 border ${
              entry === current
                ? "border-emerald-400 text-emerald-300"
                : "border-transparent text-slate-400 hover:text-slate-100"
            } cursor-pointer`}
            disabled={entry === current}
            onClick={(e) => {
              if (entry === current) return;
              if (stopPropagation) e.stopPropagation();
              onChange(entry);
            }}
          >
            {entry}
          </button>
        ),
      )}
    </div>
  );
}
