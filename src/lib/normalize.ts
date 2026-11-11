export function normalizeConfidence(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error("Confidence must be a finite number");
  }

  const clamped = Math.min(Math.max(value, 0), 100);
  return Number((clamped / 100).toFixed(2));
}
