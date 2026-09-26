import { expect, it } from "vitest";
import { continuationTitle, watchedSeriesExclusions } from "../app/lib/related-filter";
import { displayMetric, displayRankScore } from "../app/lib/recommendation-display";

it("excludes Kaguya's first season when a later season was watched, across multiple relation edges", () => {
  const excluded = watchedSeriesExclusions([43608]);
  expect([37999, 40591, 43608, 52198].every(id => excluded.has(id))).toBe(true);
  expect(excluded.has(16664)).toBe(false); // The Tale of the Princess Kaguya is unrelated.
  expect(watchedSeriesExclusions([]).has(37999)).toBe(false);
});

it("does not join unrelated franchises through a crossover", () => {
  expect(watchedSeriesExclusions([21]).has(813)).toBe(false); // One Piece / Dragon Ball Z
});

it("recognizes continuation labels across title languages and retains ordinary first-season names", () => {
  for (const title of ["作品 第二季", "作品 第３期", "Example Season 10", "Example Final Season", "Example VI", "Example 5th Season"]) {
    expect(continuationTitle(title), title).toBe(true);
  }
  for (const title of ["Kaguya-sama wa Kokurasetai: Tensai-tachi no Renai Zunousen", "86", "3-gatsu no Lion", "The Tale of the Princess Kaguya"]) {
    expect(continuationTitle(title), title).toBe(false);
  }
});

it("formats statistics and uses a fixed monotonic score display independent of pages", () => {
  expect(displayMetric(90.31106712848424)).toBe("90.3");
  expect(displayMetric(0.9523809523809523)).toBe("1.0");
  expect(displayMetric(8.18, 2)).toBe("8.18");
  expect(displayRankScore(0)).toBe("50.0");
  expect(displayRankScore(2)).toBe("88.1");
  const scores = [-5, -2, 0, 1, 2, 5].map(score => Number(displayRankScore(score)));
  expect(scores.every((score, index) => !index || score > scores[index - 1])).toBe(true);
  expect(displayRankScore(NaN)).toBe("—");
});
