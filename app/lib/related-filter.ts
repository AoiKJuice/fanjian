import { animeSeriesGroups } from "./anime-series.generated";

export function watchedSeriesExclusions(watched: number[]) {
  const groups = new Set(watched.flatMap(id => {
    const group = animeSeriesGroups.get(id);
    return group === undefined ? [] : [group];
  }));
  return new Set([...animeSeriesGroups].filter(([, group]) => groups.has(group)).map(([id]) => id));
}

export function continuationTitle(...titles: (string | null | undefined)[]) {
  return titles.some(title => {
    const value = (title ?? "").normalize("NFKC");
    return /(?:\b(?:season|part|cour)\s*(?:[2-9]|[1-9]\d+|ii|iii|iv|v|vi)\b|\b(?:[2-9](?:nd|rd|th)|second|third|fourth|fifth|final)\s+(?:season|part)\b|\br[2-9]\b|[×x]\s*(?:[2-9]|\d{3,4})\b)/i.test(value)
      || /(?:^|[\s:])(?:II|III|IV|V|VI)(?:$|[\s:])/.test(value)
      || /第\s*(?:[2-9２-９]|[1-9]\d+|[二三四五六七八九十]+)\s*[期季部]|(?:第二|第三|第四)|(?:最終|最终|完結|完结)編|\b(?:2nd|3rd|4th|5th)\b/i.test(value);
  });
}
