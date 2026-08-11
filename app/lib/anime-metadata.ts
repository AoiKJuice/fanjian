import {
  bahamutSubjectByMal,
  nonPrimaryAnimeIds,
  shortFormAnimeIds,
} from "./anime-metadata.generated";
import type { Anime, Recommendation } from "./data";

export function enrichBrowserAnime(anime: Anime): Anime {
  const isDerivative = nonPrimaryAnimeIds.has(anime.mal_id);
  const isShortForm = shortFormAnimeIds.has(anime.mal_id);
  if (anime.is_derivative === isDerivative && anime.is_short_form === isShortForm) {
    return anime;
  }
  return {
    ...anime,
    is_derivative: anime.is_derivative || isDerivative,
    is_short_form: isShortForm,
  };
}

export function enrichBrowserRecommendations(
  items: Recommendation[],
): Recommendation[] {
  return items.map((item) => ({
    ...item,
    anime: enrichBrowserAnime(item.anime),
  }));
}

export function bahamutSubjectId(malId: number) {
  return bahamutSubjectByMal.get(malId) ?? null;
}
