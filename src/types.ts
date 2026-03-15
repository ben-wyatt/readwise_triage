export interface ReaderDoc {
  id: string;
  title: string;
  url: string;
  site_name: string;
  author: string | null;
  category: string;
  location: string;
  published_date: string | null;
  created_at: string;
  word_count: number | null;
  reading_progress: number;
  tags: Record<string, unknown>;
  summary: string | null;
  // Added during scoring — not from API
  _score?: number;
  _bucket?: BucketName;
  _bucketScore?: number;
  _bucketRank?: number;
  _globalRank?: number;
  _selectedForPromotion?: boolean;
  _selectionReason?: string;
  _scoreComponents?: ScoreComponents;
}

export interface ListResponse {
  count: number;
  nextPageCursor: string | null;
  results: ReaderDoc[];
}

export type ScoreCurve = "sqrt" | "log" | "linear";

export type BucketName = "just_in" | "long_reads" | "short_blogs" | "general";

export const BUCKET_ORDER: BucketName[] = [
  "just_in",
  "long_reads",
  "short_blogs",
  "general",
];

export type BucketDocMap = Record<BucketName, ReaderDoc[]>;

export interface ScoreComponents {
  frequency: number;
  readHistory: number;
  length: number;
  recency: number;
  bucketFit: number;
 }

export interface ScoringOptions {
  windowDays: number;
  curve: ScoreCurve;
  readHistory: ReaderDoc[] | null;
  readHistoryWeight: number;
  enableLength: boolean;
  lengthWeight: number;
  justInDays: number;
  longReadMinWords: number;
  shortBlogMaxWords: number;
  maxItemsPerBucket: number;
}

export interface BucketSummary {
  bucket: BucketName;
  available: number;
  selected: number;
  maxItems: number;
  cutoffScore: number | null;
  averageSelectedAgeDays: number | null;
  oldestSelectedAgeDays: number | null;
}

export interface RankingResult {
  ranked: ReaderDoc[];
  bucketedRankings: BucketDocMap;
  selectedByBucket: BucketDocMap;
  bucketSummaries: BucketSummary[];
}

export interface Config {
  readwiseToken: string;
  scoringWindowDays: number;
  maxItemsPerBucket: number;
  scoreCurve: ScoreCurve;
  enableReadHistory: boolean;
  readHistoryWeight: number;
  enableLengthSignal: boolean;
  lengthSignalWeight: number;
  justInDays: number;
  longReadMinWords: number;
  shortBlogMaxWords: number;
  promoteTag: string;
  dryRun: boolean;
  outputJsonPath: string;
}
