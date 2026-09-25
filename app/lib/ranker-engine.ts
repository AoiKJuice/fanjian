// Frozen EASE + observed-low-rating risk + LambdaMART. Scores are not probabilities.
export type Tree = { leaf_value: number } | {
  split_feature: number; threshold: number; decision_type: string;
  left_child: Tree; right_child: Tree;
};
export type RankerMetadata = {
  schema: number; algorithm: string; item_count: number; candidate_pool: number;
  alpha: number; risk_penalty: number; mal_ids: number[]; series: string[];
  counts: number[]; low: number[]; high: number[];
  risk_model: { mean: number[]; scale: number[]; coefficients: number[] };
  trees: Tree[];
};
export type MatrixName = 'ease' | 'liked_to_low' | 'disliked_to_low' | 'disliked_to_high';
export type RowReader = (name: MatrixName, row: number) => Promise<Float32Array>;

// Match NumPy's float32 pairwise reduction for contiguous profile statistics.
export function float32Sum(values: number[], start = 0, count = values.length): number {
  const f = Math.fround;
  if (count < 8) {
    let total = -0;
    for (let i = 0; i < count; i++) total = f(total + values[start + i]);
    return total;
  }
  if (count <= 128) {
    const sums = values.slice(start, start + 8);
    let i = 8;
    for (; i < count - count % 8; i += 8) {
      for (let j = 0; j < 8; j++) sums[j] = f(sums[j] + values[start + i + j]);
    }
    let total = f(f(f(sums[0] + sums[1]) + f(sums[2] + sums[3])) +
      f(f(sums[4] + sums[5]) + f(sums[6] + sums[7])));
    for (; i < count; i++) total = f(total + values[start + i]);
    return total;
  }
  const half = Math.floor(count / 2 / 8) * 8;
  return f(float32Sum(values, start, half) + float32Sum(values, start + half, count - half));
}

export function treeScore(features: number[], trees: Tree[]) {
  let value = 0;
  for (let node of trees) {
    while (!('leaf_value' in node)) {
      if (node.decision_type !== '<=') throw new Error('Unsupported tree split');
      node = features[node.split_feature] <= node.threshold ? node.left_child : node.right_child;
    }
    value += node.leaf_value;
  }
  return value;
}

export class RankerEngine {
  private malToRow: Map<number, number>;
  constructor(readonly metadata: RankerMetadata, private readRow: RowReader) {
    const m = metadata;
    if (m.schema !== 1 || m.algorithm !== 'ease-risk-lambdamart' || m.candidate_pool !== 500 ||
        m.alpha !== .3 || m.risk_penalty !== .3 || m.trees.length !== 200 ||
        [m.mal_ids, m.series, m.counts, m.low, m.high].some(a => a.length !== m.item_count) ||
        new Set(m.mal_ids).size !== m.item_count) throw new Error('Invalid ranker metadata');
    this.malToRow = new Map(m.mal_ids.map((id, row) => [id, row]));
  }

  async recommend(profile: Record<number, number> | [number, number][], excluded: Set<number>) {
    const m = this.metadata, n = m.item_count;
    const ratings: number[] = [], liked: number[] = [], disliked: number[] = [];
    const blocked = new Set(excluded);
    const seen = new Set<number>();
    const entries = Array.isArray(profile) ? profile : Object.entries(profile);
    for (const [key, rating] of entries) {
      const id = Number(key);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id) || !Number.isFinite(rating) || rating < 1 || rating > 10) {
        throw new Error('Invalid profile rating');
      }
      seen.add(id); ratings.push(rating); blocked.add(id);
      const row = this.malToRow.get(id);
      if (row !== undefined && rating >= 8) liked.push(row);
      if (row !== undefined && rating <= 4) disliked.push(row);
    }
    if (!liked.length) return [];
    const base = new Float32Array(n);
    for (const row of liked) {
      const values = await this.readRow('ease', row);
      if (values.length !== n) throw new Error('Truncated matrix row');
      for (let j = 0; j < n; j++) base[j] += values[j];
    }
    const order = Array.from({length: n}, (_, i) => i)
      .filter(i => !blocked.has(m.mal_ids[i]) && Number.isFinite(base[i]))
      .sort((a, b) => base[b] - base[a] || a - b);
    const series = new Set<string>(), pool: number[] = [];
    for (const row of order) {
      if (m.series[row] && series.has(m.series[row])) continue;
      pool.push(row);
      if (m.series[row]) series.add(m.series[row]);
      if (pool.length === m.candidate_pool) break;
    }
    if (!pool.length) return [];
    const aggregate = async (name: MatrixName, anchors: number[], prior: number[]) => {
      if (!anchors.length) return {mean: pool.map(i => prior[i]), max: pool.map(i => prior[i])};
      const total = new Float32Array(pool.length), max = new Float32Array(pool.length).fill(-Infinity);
      for (const row of anchors) {
        const values = await this.readRow(name, row);
        if (values.length !== n) throw new Error('Truncated matrix row');
        for (let j = 0; j < pool.length; j++) {
          const value = values[pool[j]];
          total[j] += value; max[j] = Math.max(max[j], value);
        }
      }
      return {mean: Array.from(total, v => Math.fround(v / anchors.length)), max: Array.from(max)};
    };
    const pl = await aggregate('liked_to_low', liked, m.low);
    const dl = await aggregate('disliked_to_low', disliked, m.low);
    const dh = await aggregate('disliked_to_high', disliked, m.high);
    const mean = Math.fround(float32Sum(ratings) / ratings.length);
    const variance = Math.fround(float32Sum(ratings.map(b => Math.fround(Math.fround(b - mean) ** 2))) / ratings.length);
    const constants = [mean, Math.fround(Math.sqrt(variance)), ratings.filter(r => r <= 4).length / ratings.length,
      Math.log1p(ratings.length), Math.log1p(liked.length), Math.log1p(disliked.length)];
    const risk = m.risk_model;
    const rows = pool.map((row, p) => {
      const features = [base[row], m.low[row], m.high[row], Math.log1p(m.counts[row]),
        pl.mean[p], pl.max[p], dl.mean[p], dl.max[p], dh.mean[p], ...constants].map(Math.fround);
      let logit = risk.coefficients[0];
      for (let i = 0; i < 15; i++) logit += (features[i] - risk.mean[i]) / risk.scale[i] * risk.coefficients[i + 1];
      const lowRisk = 1 / (1 + Math.exp(-logit));
      return {mal_id: m.mal_ids[row], row, position: p, base: base[row],
        baseline: base[row] - .3 * lowRisk, tree: treeScore(features, m.trees), lowRisk};
    });
    const statistics = (values: number[]) => {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return [mean, Math.max(1e-8, Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length))];
    };
    const [bm, bs] = statistics(rows.map(r => r.baseline));
    const [tm, ts] = statistics(rows.map(r => r.tree));
    return rows.map(r => ({...r, score: .7 * (r.baseline - bm) / bs + .3 * (r.tree - tm) / ts}))
      .sort((a, b) => b.score - a.score || a.position - b.position);
  }
}
