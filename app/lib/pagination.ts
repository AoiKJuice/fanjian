export function recommendationPageItems(
  currentPage: number,
  totalPages: number,
  hasMore = false,
): Array<number | "previous" | "next"> {
  const groupStart = Math.floor((Math.max(1, currentPage) - 1) / 5) * 5 + 1;
  const groupEnd = Math.min(groupStart + 4, totalPages);
  const pages = Array.from(
    { length: Math.max(0, groupEnd - groupStart + 1) },
    (_, index) => groupStart + index,
  );
  return [
    ...(groupStart > 1 ? ["previous" as const] : []),
    ...pages,
    ...(groupEnd < totalPages || hasMore ? ["next" as const] : []),
  ];
}
