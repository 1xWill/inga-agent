"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function DashboardAutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const ms = Math.max(3000, Math.floor(intervalMs || 0));
    const id = setInterval(() => {
      router.refresh();
    }, ms);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}

