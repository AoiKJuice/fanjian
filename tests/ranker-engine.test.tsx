import { describe, expect, it } from 'vitest';
import { RankerEngine, float32Sum, treeScore, type RankerMetadata } from '../app/lib/ranker-engine';

function engine() {
  const metadata: RankerMetadata = {
    schema: 1, algorithm: 'ease-risk-lambdamart', item_count: 3, candidate_pool: 500,
    alpha: .3, risk_penalty: .3, mal_ids: [1, 2, 3], series: ['a', 'b', 'c'],
    counts: [30, 50, 80], low: [.1, .2, .3], high: [.5, .6, .7],
    risk_model: {mean: Array(15).fill(0), scale: Array(15).fill(1), coefficients: Array(16).fill(0)},
    trees: Array.from({length: 200}, () => ({leaf_value: 0})),
  };
  return new RankerEngine(metadata, async (name) =>
    new Float32Array(name === 'ease' ? [0, .8, .2] : [.1, .2, .3]));
}

describe('frozen ranking inference', () => {
  it('excludes known and hidden titles before candidate normalization', async () => {
    const all = await engine().recommend({1: 8}, new Set());
    expect(all.map(r => r.mal_id)).toEqual([2, 3]);
    const filtered = await engine().recommend({1: 8}, new Set([2]));
    expect(filtered.map(r => r.mal_id)).toEqual([3]);
    expect(filtered[0].score).toBe(0); // one eligible candidate has zero centered score
  });
  it('returns no recommendations without supported high ratings', async () => {
    expect(await engine().recommend({1: 7, 99: 10}, new Set())).toEqual([]);
    expect(await engine().recommend({}, new Set())).toEqual([]);
  });
  it('rejects duplicate and nonfinite ratings', async () => {
    await expect(engine().recommend([[1, 8], [1, 9]], new Set())).rejects.toThrow();
    await expect(engine().recommend({1: NaN}, new Set())).rejects.toThrow();
  });
  it('uses inclusive numeric tree thresholds and sums leaf values', () => {
    expect(treeScore([2], [{split_feature: 0, threshold: 2, decision_type: '<=',
      left_child: {leaf_value: .75}, right_child: {leaf_value: -1}}, {leaf_value: .25}])).toBe(1);
  });
  it('retains float32 accumulation instead of double precision statistics', () => {
    expect(float32Sum([1e8, 1, -1e8])).toBe(0);
    expect(float32Sum([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(45);
  });
});
