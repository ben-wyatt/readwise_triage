import { fetchFeedDocs, fetchReadHistory, bulkUpdateDocs } from "./readwise";
import { scoreAndRank, printScoringReport } from "./scoring";
import { BUCKET_ORDER, Config } from "./types";

function parseIntEnv(name: string, fallback: string): number {
  return parseInt(process.env[name] ?? fallback, 10);
}

function parseFloatEnv(name: string, fallback: string): number {
  return parseFloat(process.env[name] ?? fallback);
}

function loadConfig(): Config {
  const token = process.env.READWISE_TOKEN;
  if (!token) {
    throw new Error(
      "READWISE_TOKEN is required. Set it in .env or as an environment variable."
    );
  }

  const curve = process.env.SCORE_CURVE ?? "sqrt";
  if (!["sqrt", "log", "linear"].includes(curve)) {
    throw new Error(`Invalid SCORE_CURVE: "${curve}". Use sqrt, log, or linear.`);
  }

  return {
    readwiseToken: token,
    scoringWindowDays: parseIntEnv("SCORING_WINDOW_DAYS", "14"),
    maxItemsPerBucket: parseIntEnv("MAX_ITEMS_PER_BUCKET", "15"),
    scoreCurve: curve as Config["scoreCurve"],
    enableReadHistory: process.env.ENABLE_READ_HISTORY === "true",
    readHistoryWeight: parseFloatEnv("READ_HISTORY_WEIGHT", "0.5"),
    enableLengthSignal: process.env.ENABLE_LENGTH_SIGNAL === "true",
    lengthSignalWeight: parseFloatEnv("LENGTH_SIGNAL_WEIGHT", "0.2"),
    justInDays: parseIntEnv("JUST_IN_DAYS", "14"),
    longReadMinWords: parseIntEnv("LONG_READ_MIN_WORDS", "2500"),
    shortBlogMaxWords: parseIntEnv("SHORT_BLOG_MAX_WORDS", "1200"),
    promoteTag: process.env.PROMOTE_TAG ?? "triage",
    dryRun: process.env.DRY_RUN !== "false",
    outputJsonPath: process.env.OUTPUT_JSON_PATH ?? "output/readwise-triage.json",
  };
}

async function writeJsonReport(
  outputPath: string,
  payload: unknown
): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");
  const resolved = path.resolve(process.cwd(), outputPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Saved JSON report to ${resolved}`);
}

async function run(): Promise<void> {
  // Support .env file loading without a dependency
  try {
    const fs = await import("fs");
    const path = await import("path");
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
        if (!process.env[key]) process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }

  const config = loadConfig();

  console.log("Readwise Feed Ranker");
  console.log(`Mode: ${config.dryRun ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`Scoring window: ${config.scoringWindowDays} days`);
  console.log(`Max items per bucket: ${config.maxItemsPerBucket}`);
  console.log(`Curve: ${config.scoreCurve}`);
  console.log(`Read history: ${config.enableReadHistory}`);
  console.log(`Length signal: ${config.enableLengthSignal}`);
  console.log(`Buckets: ${BUCKET_ORDER.join(", ")}`);
  console.log(`JSON output: ${config.outputJsonPath}`);
  console.log("");

  // 1. Fetch feed items
  console.log("Fetching RSS feed items...");
  const feedDocs = await fetchFeedDocs(config.readwiseToken);
  console.log(`  Found ${feedDocs.length} items in feed`);

  // 2. Optionally fetch read history
  let readHistory = null;
  if (config.enableReadHistory) {
    console.log("Fetching read history...");
    readHistory = await fetchReadHistory(config.readwiseToken);
    console.log(`  Found ${readHistory.length} archived items`);
  }

  // 3. Score and rank
  const ranked = scoreAndRank(feedDocs, {
    windowDays: config.scoringWindowDays,
    curve: config.scoreCurve,
    readHistory,
    readHistoryWeight: config.readHistoryWeight,
    enableLength: config.enableLengthSignal,
    lengthWeight: config.lengthSignalWeight,
    justInDays: config.justInDays,
    longReadMinWords: config.longReadMinWords,
    shortBlogMaxWords: config.shortBlogMaxWords,
    maxItemsPerBucket: config.maxItemsPerBucket,
  });

  // 4. Print report
  printScoringReport(ranked, config.maxItemsPerBucket);

  // 5. Promote
  const toPromote = BUCKET_ORDER.flatMap(
    (bucket) => ranked.selectedByBucket[bucket]
  );

  const now = new Date().toISOString();
  await writeJsonReport(config.outputJsonPath, {
    generatedAt: now,
    mode: config.dryRun ? "dry-run" : "live",
    config: {
      scoringWindowDays: config.scoringWindowDays,
      maxItemsPerBucket: config.maxItemsPerBucket,
      scoreCurve: config.scoreCurve,
      enableReadHistory: config.enableReadHistory,
      readHistoryWeight: config.readHistoryWeight,
      enableLengthSignal: config.enableLengthSignal,
      lengthSignalWeight: config.lengthSignalWeight,
      justInDays: config.justInDays,
      longReadMinWords: config.longReadMinWords,
      shortBlogMaxWords: config.shortBlogMaxWords,
      promoteTag: config.promoteTag,
    },
    counts: {
      feedDocs: feedDocs.length,
      rankedDocs: ranked.ranked.length,
      selectedDocs: toPromote.length,
    },
    bucketSummaries: ranked.bucketSummaries,
    selectedByBucket: ranked.selectedByBucket,
    bucketedRankings: ranked.bucketedRankings,
    ranked: ranked.ranked,
  });

  if (config.dryRun) {
    console.log("\nDRY RUN — no changes made to Readwise.");
    return;
  }

  console.log(`\nPromoting ${toPromote.length} selected items to inbox...`);
  for (const bucket of BUCKET_ORDER) {
    const selected = ranked.selectedByBucket[bucket];
    if (selected.length === 0) continue;

    const tags = config.promoteTag
      ? [config.promoteTag, `${config.promoteTag}/${bucket}`]
      : [bucket];

    console.log(
      `  ${bucket}: ${selected.length} items -> ${tags.join(", ")}`
    );
    await bulkUpdateDocs(config.readwiseToken, selected, {
      location: "new",
      tags,
    });
  }
  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
