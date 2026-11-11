"use client";

type CitationsProps = {
  urls: string[];
  first?: number;
  label?: string;
};

// Simple hover swap: collapsed (first N + …) vs expanded (all), no animation
export function CitationsBlock({
  urls,
  first = 5,
  label = "Citations:",
}: CitationsProps) {
  const head = urls.slice(0, first);
  const tail = urls.slice(first);
  const hasTail = tail.length > 0;

  const renderLink = (u: string, idx: number) => {
    let host = u;
    try {
      host = new URL(u).hostname.replace(/^www\./, "");
    } catch {}
    return (
      <a
        key={idx}
        href={u}
        target="_blank"
        rel="noreferrer"
        title={host}
        className="inline-block ml-1 hover:text-slate-100 underline underline-offset-2"
        onClick={(ev) => ev.stopPropagation()}
      >
        [{idx + 1}]
      </a>
    );
  };

  if (!hasTail) {
    return (
      <span className="inline">
        <span>{label} </span>
        {head.map(renderLink)}
      </span>
    );
  }

  return (
    <span className="inline group/cites">
      <span className="inline group-hover/cites:hidden">
        <span>{label} </span>
        {head.map(renderLink)}
        <span className="inline-block ml-1 text-slate-300/60 select-none">
          …
        </span>
      </span>
      <span className="hidden group-hover/cites:inline">
        <span>{label} </span>
        {urls.map(renderLink)}
      </span>
    </span>
  );
}
