// A fixed monotonic display scale. Raw scores stay untouched for ordering/history.
export function displayRankScore(score: number) {
  if (!Number.isFinite(score)) return "—";
  return (100 / (1 + Math.exp(-score))).toFixed(1);
}

export function displayMetric(value: number, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "—";
}
