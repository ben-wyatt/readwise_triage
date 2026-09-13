import { scoreAndRank } from "../../src/scoring";
import { BUCKET_ORDER, Config, ReaderDoc } from "../../src/types";

interface Env {
  DB: D1Database;
  READWISE_TOKEN: string;
  DRY_RUN: string;
  SCORING_WINDOW_DAYS: string;
  MAX_ITEMS_PER_BUCKET: string;
  SCORE_CURVE: string;
  ENABLE_READ_HISTORY: string;
  READ_HISTORY_WEIGHT: string;
  ENABLE_LENGTH_SIGNAL: string;
  LENGTH_SIGNAL_WEIGHT: string;
  JUST_IN_DAYS: string;
  LONG_READ_MIN_WORDS: string;
  SHORT_BLOG_MAX_WORDS: string;
  PROMOTE_TAG: string;
  READWISE_MAX_REQUESTS_PER_MIN: string;
  BOOTSTRAP_MAX_PAGES_PER_RUN: string;
}

interface ListResponse {
  nextPageCursor: string | null;
  results: ReaderDoc[];
}

interface DocumentRow {
  id: string;
  title: string;
  url: string;
  site_name: string;
  author: string | null;
  category: string;
  location: string;
  published_date: string | null;
  created_at: string;
  updated_at: string;
  word_count: number | null;
  reading_progress: number;
  tags_json: string;
  summary: string | null;
}

const READER_LIST_URL = "https://readwise.io/api/v3/list/";
const READER_BULK_UPDATE_URL = "https://readwise.io/api/v3/bulk_update/";
const DAILY_TRIAGE_CRON = "17 10 * * *";
const BOOTSTRAP_CRON = "15 * * * *";
const OVERLAP_MS = 10 * 60 * 1000;
const MAX_RETRIES = 4;

function numberEnv(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalEnv(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(env: Env): Config {
  const curve = env.SCORE_CURVE;
  if (curve !== "sqrt" && curve !== "log" && curve !== "linear") {
    throw new Error(`Invalid SCORE_CURVE: ${curve}`);
  }

  return {
    readwiseToken: env.READWISE_TOKEN,
    scoringWindowDays: numberEnv(env.SCORING_WINDOW_DAYS, 14),
    maxItemsPerBucket: numberEnv(env.MAX_ITEMS_PER_BUCKET, 15),
    scoreCurve: curve,
    enableReadHistory: env.ENABLE_READ_HISTORY === "true",
    readHistoryWeight: decimalEnv(env.READ_HISTORY_WEIGHT, 0.5),
    enableLengthSignal: env.ENABLE_LENGTH_SIGNAL === "true",
    lengthSignalWeight: decimalEnv(env.LENGTH_SIGNAL_WEIGHT, 0.2),
    justInDays: numberEnv(env.JUST_IN_DAYS, 14),
    longReadMinWords: numberEnv(env.LONG_READ_MIN_WORDS, 2500),
    shortBlogMaxWords: numberEnv(env.SHORT_BLOG_MAX_WORDS, 1200),
    promoteTag: env.PROMOTE_TAG,
    dryRun: env.DRY_RUN !== "false",
    outputJsonPath: "",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readwiseLimit(env: Env): number {
  return Math.min(Math.max(numberEnv(env.READWISE_MAX_REQUESTS_PER_MIN, 20), 1), 20);
}

function readwiseToken(env: Env): string {
  // `.dev.vars` values occasionally carry a human note after `#`. Cloudflare
  // secrets are stored raw, but accepting that local convention keeps a note
  // from becoming part of the Authorization header during development.
  const token = env.READWISE_TOKEN.split(/\s+#/, 1)[0].trim();
  if (!token) throw new Error("READWISE_TOKEN is required");
  return token;
}

async function readwiseFetch(
  env: Env,
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Token ${readwiseToken(env)}`,
        ...init.headers,
      },
    });
    if (response.status !== 429) return response;

    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    const backoffMs = Number.isFinite(retryAfter)
      ? Math.max(retryAfter, 1) * 1000
      : 1_000 * 2 ** attempt;
    await sleep(backoffMs);
  }
  throw new Error("Readwise rate limit retry budget exhausted");
}

async function fetchChangedDocuments(
  env: Env,
  updatedAfter: string | null,
  startingCursor: string | null,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<{ documents: ReaderDoc[]; nextCursor: string | null }> {
  const documents: ReaderDoc[] = [];
  let cursor = startingCursor;
  let pageCount = 0;
  const intervalMs = Math.ceil(60_000 / readwiseLimit(env));

  do {
    const url = new URL(READER_LIST_URL);
    url.searchParams.set("category", "rss");
    url.searchParams.set("limit", "100");
    if (updatedAfter) url.searchParams.set("updatedAfter", updatedAfter);
    if (!updatedAfter) url.searchParams.set("location", "feed");
    if (cursor) url.searchParams.set("pageCursor", cursor);

    const response = await readwiseFetch(env, url.toString(), {});
    if (!response.ok) {
      throw new Error(`Readwise list failed: ${response.status} ${await response.text()}`);
    }
    const page = (await response.json()) as ListResponse;
    documents.push(...page.results);
    cursor = page.nextPageCursor;
    pageCount += 1;
    if (cursor && pageCount < maxPages) await sleep(intervalMs);
  } while (cursor && pageCount < maxPages);

  return { documents, nextCursor: cursor };
}

function documentTimestamp(document: ReaderDoc): string {
  return document.updated_at ?? document.created_at;
}

function documentStatements(env: Env, documents: ReaderDoc[], now: string): D1PreparedStatement[] {
  return documents.map((document) =>
    env.DB.prepare(
      `INSERT INTO triage_documents (
        id, title, url, site_name, author, category, location, published_date,
        created_at, updated_at, word_count, reading_progress, tags_json, summary, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        site_name = excluded.site_name,
        author = excluded.author,
        category = excluded.category,
        location = excluded.location,
        published_date = excluded.published_date,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        word_count = excluded.word_count,
        reading_progress = excluded.reading_progress,
        tags_json = excluded.tags_json,
        summary = excluded.summary,
        synced_at = excluded.synced_at`,
    ).bind(
      document.id,
      document.title,
      document.url,
      document.site_name || document.author || "unknown",
      document.author,
      document.category,
      document.location,
      document.published_date,
      document.created_at,
      documentTimestamp(document),
      document.word_count,
      document.reading_progress,
      JSON.stringify(document.tags ?? {}),
      document.summary,
      now,
    ),
  );
}

async function persistDocuments(env: Env, documents: ReaderDoc[], now: string): Promise<void> {
  const statements = documentStatements(env, documents, now);
  for (let index = 0; index < statements.length; index += 500) {
    await env.DB.batch(statements.slice(index, index + 500));
  }
}

function rowToDocument(row: DocumentRow): ReaderDoc {
  let tags: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.tags_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      tags = parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt tag payload must not prevent an otherwise valid item from being triaged.
  }

  return {
    id: row.id,
    title: row.title,
    url: row.url,
    site_name: row.site_name,
    author: row.author,
    category: row.category,
    location: row.location,
    published_date: row.published_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
    word_count: row.word_count,
    reading_progress: row.reading_progress,
    tags,
    summary: row.summary,
  };
}

async function activeFeedDocuments(env: Env): Promise<ReaderDoc[]> {
  const result = await env.DB.prepare(
    `SELECT id, title, url, site_name, author, category, location, published_date,
      created_at, updated_at, word_count, reading_progress, tags_json, summary
     FROM triage_documents
     WHERE category = 'rss' AND location = 'feed'`,
  ).all<DocumentRow>();
  return result.results.map(rowToDocument);
}

async function getState(env: Env, key: string): Promise<string | null> {
  return env.DB.prepare("SELECT value FROM triage_state WHERE key = ?")
    .bind(key)
    .first<string>("value");
}

async function setState(env: Env, key: string, value: string, now: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO triage_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, now).run();
}

async function claimRun(env: Env, runKey: string, now: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO triage_runs (run_key, status, started_at)
     VALUES (?, 'running', ?)
     ON CONFLICT(run_key) DO UPDATE SET
       status = 'running', started_at = excluded.started_at, finished_at = NULL, error = NULL
     WHERE triage_runs.status = 'failed'`,
  ).bind(runKey, now).run();
  return result.meta.changes > 0;
}

async function completeRun(
  env: Env,
  runKey: string,
  status: "succeeded" | "failed",
  now: string,
  counts: { fetched: number; candidates: number; promoted: number },
  error: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE triage_runs
     SET status = ?, finished_at = ?, documents_fetched = ?, candidates_scored = ?,
       documents_promoted = ?, error = ?
     WHERE run_key = ?`,
  ).bind(status, now, counts.fetched, counts.candidates, counts.promoted, error, runKey).run();
}

async function recordDecisions(
  env: Env,
  runKey: string,
  documents: ReaderDoc[],
  now: string,
): Promise<void> {
  const statements = documents.map((document) =>
    env.DB.prepare(
      `INSERT INTO triage_decisions
       (run_key, document_id, bucket, score, bucket_rank, promoted, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runKey,
      document.id,
      document._bucket ?? "general",
      document._score ?? 0,
      document._bucketRank ?? 0,
      0,
      now,
    ),
  );
  if (statements.length > 0) await env.DB.batch(statements);
}

function promotionTags(document: ReaderDoc, baseTag: string): string[] {
  const existing = document.tags && typeof document.tags === "object"
    ? Object.keys(document.tags)
    : [];
  const bucket = document._bucket ?? "general";
  const additions = baseTag ? [baseTag, `${baseTag}/${bucket}`] : [bucket];
  return [...new Set([...existing, ...additions])];
}

async function promoteDocuments(env: Env, documents: ReaderDoc[], config: Config): Promise<void> {
  for (let start = 0; start < documents.length; start += 50) {
    const batch = documents.slice(start, start + 50);
    const response = await readwiseFetch(env, READER_BULK_UPDATE_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        updates: batch.map((document) => ({
          id: document.id,
          location: "new",
          tags: promotionTags(document, config.promoteTag),
        })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Readwise bulk update failed: ${response.status} ${await response.text()}`);
    }
    if (response.status === 207) {
      const payload = (await response.json()) as {
        results?: Array<{ id: string; success: boolean; error?: string }>;
      };
      const failures = payload.results?.filter((result) => !result.success) ?? [];
      if (failures.length > 0) {
        throw new Error(`Readwise partial bulk update: ${failures.map((failure) => `${failure.id}: ${failure.error ?? "unknown"}`).join("; ")}`);
      }
    }
  }
}

async function markPromoted(env: Env, runKey: string, documents: ReaderDoc[], now: string, config: Config): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const document of documents) {
    statements.push(
      env.DB.prepare(
        `UPDATE triage_documents SET location = 'new', tags_json = ?, updated_at = ?, synced_at = ?
         WHERE id = ?`,
      ).bind(JSON.stringify(Object.fromEntries(promotionTags(document, config.promoteTag).map((tag) => [tag, {}]))), now, now, document.id),
      env.DB.prepare(
        `UPDATE triage_decisions SET promoted = 1
         WHERE run_key = ? AND document_id = ?`,
      ).bind(runKey, document.id),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

async function runTriage(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date().toISOString();
  const runKey = new Date(scheduledTime).toISOString();
  if (!(await claimRun(env, runKey, now))) {
    console.log(`Skipping duplicate triage run ${runKey}`);
    return;
  }

  let fetched = 0;
  let candidates = 0;
  let promoted = 0;
  try {
    const previousSuccess = await getState(env, "last_success_at");
    const isBootstrap = previousSuccess === null;
    const bootstrapCursor = isBootstrap
      ? await getState(env, "bootstrap_cursor")
      : null;
    let bootstrapStartedAt = isBootstrap
      ? await getState(env, "bootstrap_started_at")
      : null;
    if (isBootstrap && !bootstrapStartedAt) {
      bootstrapStartedAt = now;
      await setState(env, "bootstrap_started_at", bootstrapStartedAt, now);
    }
    const updatedAfter = previousSuccess
      ? new Date(Date.parse(previousSuccess) - OVERLAP_MS).toISOString()
      : null;
    const sync = await fetchChangedDocuments(
      env,
      updatedAfter,
      bootstrapCursor,
      isBootstrap ? numberEnv(env.BOOTSTRAP_MAX_PAGES_PER_RUN, 5) : Number.POSITIVE_INFINITY,
    );
    fetched = sync.documents.length;
    await persistDocuments(env, sync.documents, now);

    if (isBootstrap) {
      if (sync.nextCursor) {
        await setState(env, "bootstrap_cursor", sync.nextCursor, now);
        await completeRun(env, runKey, "succeeded", now, { fetched, candidates, promoted });
        console.log(JSON.stringify({ runKey, fetched, bootstrap: "in-progress" }));
        return;
      }

      // Catch the changes that occurred while the multi-run bootstrap was in progress
      // before selecting or moving anything in Reader.
      await setState(env, "last_success_at", bootstrapStartedAt ?? now, now);
      await completeRun(env, runKey, "succeeded", now, { fetched, candidates, promoted });
      console.log(JSON.stringify({ runKey, fetched, bootstrap: "complete" }));
      return;
    }

    const config = loadConfig(env);
    const active = await activeFeedDocuments(env);
    const ranking = scoreAndRank(active, {
      windowDays: config.scoringWindowDays,
      curve: config.scoreCurve,
      readHistory: null,
      readHistoryWeight: config.readHistoryWeight,
      enableLength: config.enableLengthSignal,
      lengthWeight: config.lengthSignalWeight,
      justInDays: config.justInDays,
      longReadMinWords: config.longReadMinWords,
      shortBlogMaxWords: config.shortBlogMaxWords,
      maxItemsPerBucket: config.maxItemsPerBucket,
    });
    candidates = ranking.ranked.length;
    const selected = BUCKET_ORDER.flatMap((bucket) => ranking.selectedByBucket[bucket]);
    await recordDecisions(env, runKey, selected, now);

    if (!config.dryRun && selected.length > 0) {
      await promoteDocuments(env, selected, config);
      await markPromoted(env, runKey, selected, now, config);
      promoted = selected.length;
    }

    await setState(env, "last_success_at", now, now);
    await completeRun(env, runKey, "succeeded", now, { fetched, candidates, promoted });
    console.log(JSON.stringify({ runKey, fetched, candidates, selected: selected.length, promoted, dryRun: config.dryRun }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeRun(env, runKey, "failed", new Date().toISOString(), { fetched, candidates, promoted }, message);
    throw error;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron !== DAILY_TRIAGE_CRON && controller.cron !== BOOTSTRAP_CRON) {
      console.log(`Skipping unrecognized cron trigger: ${controller.cron}`);
      return;
    }
    if (controller.cron === BOOTSTRAP_CRON && await getState(env, "last_success_at")) {
      console.log("Bootstrap already complete; skipping hourly bootstrap trigger");
      return;
    }
    ctx.waitUntil(runTriage(env, controller.scheduledTime));
  },
};
