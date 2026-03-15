import {
  BUCKET_ORDER,
  BucketDocMap,
  BucketName,
  BucketSummary,
  RankingResult,
  ReaderDoc,
  ScoringOptions,
} from "./types";

function freqScore(count: number, curve: ScoringOptions["curve"]): number {
  switch (curve) {
    case "sqrt":
      return 1 / Math.sqrt(count);
    case "log":
      return 1 / Math.log2(count + 1);
    case "linear":
      return 1 / count;
  }
}

function sourceName(doc: ReaderDoc): string {
  return doc.site_name || doc.author || "unknown";
}

function docTimestamp(doc: ReaderDoc): number {
  return doc.published_date
    ? new Date(doc.published_date).getTime()
    : new Date(doc.created_at).getTime();
}

function compareDocs(a: ReaderDoc, b: ReaderDoc): number {
  const scoreDiff = (b._score ?? 0) - (a._score ?? 0);
  if (scoreDiff !== 0) return scoreDiff;

  const timeDiff = docTimestamp(b) - docTimestamp(a);
  if (timeDiff !== 0) return timeDiff;

  const wordDiff = (b.word_count ?? 0) - (a.word_count ?? 0);
  if (wordDiff !== 0) return wordDiff;

  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) return titleDiff;

  return a.id.localeCompare(b.id);
}

function lengthSignal(wordCount: number | null, pivot: number): number {
  if (wordCount === null || wordCount <= 0) return 0;
  return wordCount / (wordCount + pivot);
}

function shortnessSignal(wordCount: number | null, pivot: number): number {
  if (wordCount === null || wordCount <= 0) return 0;
  return pivot / (wordCount + pivot);
}

function classifyBucket(doc: ReaderDoc, now: number, opts: ScoringOptions): BucketName {
  const ageMs = Math.max(0, now - docTimestamp(doc));
  const justInMs = opts.justInDays * 24 * 60 * 60 * 1000;
  if (ageMs <= justInMs) return "just_in";
  if (doc.word_count !== null && doc.word_count >= opts.longReadMinWords) {
    return "long_reads";
  }
  if (doc.word_count !== null && doc.word_count <= opts.shortBlogMaxWords) {
    return "short_blogs";
  }
  return "general";
}

function computeDocScore(
  doc: ReaderDoc,
  freqScores: Map<string, number>,
  readRates: Map<string, number>,
  opts: ScoringOptions,
  now: number,
  windowMs: number
): Pick<
  ReaderDoc,
  "_bucket" | "_bucketScore" | "_score" | "_scoreComponents"
> {
  const source = sourceName(doc);
  const freq = freqScores.get(source) ?? 1;
  const bucket = classifyBucket(doc, now, opts);
  const age = Math.max(0, now - docTimestamp(doc));
  const recency = 1 / (1 + age / windowMs);
  const longness = lengthSignal(doc.word_count, opts.longReadMinWords);
  const shortness = shortnessSignal(doc.word_count, opts.shortBlogMaxWords);

  const readHistory =
    opts.readHistory !== null
      ? opts.readHistoryWeight * (readRates.get(source) ?? 0)
      : 0;

  const length = opts.enableLength ? opts.lengthWeight * longness : 0;
  const recencyBonus = 0.03 * recency;

  let bucketFit = 0;
  switch (bucket) {
    case "just_in":
      bucketFit = 0.1 * recency;
      break;
    case "long_reads":
      bucketFit = 0.1 * longness;
      break;
    case "short_blogs":
      bucketFit = 0.1 * shortness;
      break;
    case "general":
      bucketFit = 0.04 * recency + 0.04 * (1 - Math.abs(longness - 0.5));
      break;
  }

  const bonus = readHistory + length + recencyBonus + bucketFit;
  const score = freq * (1 + bonus);

  return {
    _bucket: bucket,
    _bucketScore: score,
    _score: score,
    _scoreComponents: {
      frequency: freq,
      readHistory,
      length,
      recency: recencyBonus,
      bucketFit,
    },
  };
}

function buildReadRates(history: ReaderDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  const completions = new Map<string, number>();

  for (const doc of history) {
    const source = doc.site_name || doc.author || "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
    if (doc.reading_progress >= 0.8) {
      completions.set(source, (completions.get(source) ?? 0) + 1);
    }
  }

  const rates = new Map<string, number>();
  for (const [source, total] of counts) {
    rates.set(source, (completions.get(source) ?? 0) / total);
  }
  return rates;
}

function buildBucketSummaries(
  bucketedRankings: BucketDocMap,
  selectedByBucket: BucketDocMap,
  opts: ScoringOptions,
  now: number
): BucketSummary[] {
  return BUCKET_ORDER.map((bucket) => {
    const selected = selectedByBucket[bucket];
    const selectedAgesInDays = selected.map(
      (doc) => Math.max(0, now - docTimestamp(doc)) / (24 * 60 * 60 * 1000)
    );

    return {
      bucket,
      available: bucketedRankings[bucket].length,
      selected: selected.length,
      maxItems: opts.maxItemsPerBucket,
      cutoffScore:
        selected.length > 0 ? selected[selected.length - 1]._bucketScore ?? null : null,
      averageSelectedAgeDays:
        selectedAgesInDays.length > 0
          ? selectedAgesInDays.reduce((sum, age) => sum + age, 0) /
            selectedAgesInDays.length
          : null,
      oldestSelectedAgeDays:
        selectedAgesInDays.length > 0 ? Math.max(...selectedAgesInDays) : null,
    };
  });
}

function markSelectedDocs(selected: ReaderDoc[], reason: string): void {
  for (const doc of selected) {
    doc._selectedForPromotion = true;
    doc._selectionReason = reason;
  }
}

function emptyBucketDocMap(): BucketDocMap {
  return {
    just_in: [],
    long_reads: [],
    short_blogs: [],
    general: [],
  };
}

export function scoreAndRank(docs: ReaderDoc[], opts: ScoringOptions): RankingResult {
  const now = Date.now();
  const windowMs = opts.windowDays * 24 * 60 * 60 * 1000;

  const windowDocs = docs.filter((d) => {
    return now - docTimestamp(d) <= windowMs;
  });

  const sourceCounts = new Map<string, number>();
  for (const doc of windowDocs) {
    const source = sourceName(doc);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  const freqScores = new Map<string, number>();
  for (const [source, count] of sourceCounts) {
    freqScores.set(source, freqScore(count, opts.curve));
  }

  const readRates =
    opts.readHistory !== null ? buildReadRates(opts.readHistory) : new Map();

  const scored = docs.map((doc) => ({
    ...doc,
    ...computeDocScore(doc, freqScores, readRates, opts, now, windowMs),
  }));

  const groupedDocs = emptyBucketDocMap();
  for (const doc of scored) {
    const bucket = doc._bucket ?? "general";
    groupedDocs[bucket].push(doc);
  }

  const bucketedRankings = emptyBucketDocMap();
  for (const bucket of BUCKET_ORDER) {
    const bucketDocs = [...groupedDocs[bucket]];
    bucketDocs.sort(compareDocs);
    bucketDocs.forEach((doc, index) => {
      doc._bucketRank = index + 1;
    });
    bucketedRankings[bucket] = bucketDocs;
  }

  const ranked = [...scored].sort(compareDocs);
  ranked.forEach((doc, index) => {
    doc._globalRank = index + 1;
  });

  const selectedByBucket = emptyBucketDocMap();
  for (const bucket of BUCKET_ORDER) {
    const selected = bucketedRankings[bucket].slice(0, opts.maxItemsPerBucket);
    markSelectedDocs(selected, `top ${selected.length} in ${bucket}`);
    selectedByBucket[bucket] = selected;
  }

  return {
    ranked,
    bucketedRankings,
    selectedByBucket,
    bucketSummaries: buildBucketSummaries(
      bucketedRankings,
      selectedByBucket,
      opts,
      now
    ),
  };
}

export function printScoringReport(
  result: RankingResult,
  maxItemsPerBucket: number
): void {
  const { ranked, selectedByBucket, bucketSummaries } = result;
  console.log("\n=== Scoring Report ===");
  console.log(`Total feed items: ${ranked.length}`);
  console.log(`Max selected per bucket: ${maxItemsPerBucket}\n`);

  const sourceCounts = new Map<string, number>();
  for (const doc of ranked) {
    const s = sourceName(doc);
    sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
  }

  console.log("Source distribution (top 10 by count):");
  [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([s, n]) => console.log(`  ${s}: ${n} items`));

  console.log("\nBucket summary:");
  bucketSummaries.forEach((summary) => {
    const cutoff =
      summary.cutoffScore === null ? "n/a" : summary.cutoffScore.toFixed(5);
    const averageAge =
      summary.averageSelectedAgeDays === null
        ? "n/a"
        : `${summary.averageSelectedAgeDays.toFixed(1)}d`;
    const oldestAge =
      summary.oldestSelectedAgeDays === null
        ? "n/a"
        : `${summary.oldestSelectedAgeDays.toFixed(1)}d`;
    console.log(
      `  ${summary.bucket}: available=${summary.available}, selected=${summary.selected}/${summary.maxItems}, cutoff=${cutoff}, avg_age=${averageAge}, oldest=${oldestAge}`
    );
  });

  console.log("\nSelected items by bucket:");
  BUCKET_ORDER.forEach((bucket) => {
    const selected = selectedByBucket[bucket];
    console.log(`\n  ${bucket}:`);
    if (selected.length === 0) {
      console.log("    (none)");
      return;
    }

    selected.forEach((doc, index) => {
      const score = (doc._score ?? 0).toFixed(5);
      const source = sourceName(doc);
      const words = doc.word_count ? `${doc.word_count}w` : "?w";
      console.log(
        `    ${index + 1}. [${score}] ${doc.title} — ${source} (${words})`
      );
    });
  });
}
