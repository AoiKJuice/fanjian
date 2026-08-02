export type Anime = {
  mal_id: number;
  title_zh: string;
  title_native: string;
  title_en: string;
  format: string;
  episodes: number;
  year: number;
  release_status: string;
  synopsis: string;
  cover_index: number;
  cover_url?: string | null;
  platform_mean: number | null;
  bangumi_score?: number | null;
  matched_tags?: string[];
  is_sequel?: boolean;
  is_derivative?: boolean;
};

export type Evidence = {
  mal_id: number;
  title: string;
  your_rating: number;
  signal: string;
  contribution: number;
};

export type Recommendation = {
  anime: Anime;
  rank_score: number;
  affinity: number;
  confidence: "高" | "中" | "低";
  support: number;
  effective_sample_size: number;
  reason: string;
  evidence: Evidence[];
  neighbor_distribution: Record<string, number>;
  risk: string;
  relation_notice?: string | null;
};
