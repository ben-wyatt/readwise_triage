import { ReaderDoc, ListResponse } from "./types";

const BASE_URL = "https://readwise.io";
const DELAY_MS = 200; // conservative delay between paginated requests
const DEFAULT_MAX_REQUESTS_PER_MIN = 240;
const MIN_REQUESTS_PER_MIN = 1;
const MAX_REQUESTS_PER_MIN = 240;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 6;

function getMaxRequestsPerMinute(): number {
  const raw = parseInt(
    process.env.READWISE_MAX_REQUESTS_PER_MIN ??
      `${DEFAULT_MAX_REQUESTS_PER_MIN}`,
    10
  );
  if (Number.isNaN(raw)) return DEFAULT_MAX_REQUESTS_PER_MIN;
  return Math.min(Math.max(raw, MIN_REQUESTS_PER_MIN), MAX_REQUESTS_PER_MIN);
}

const REQUEST_INTERVAL_MS = Math.ceil(60_000 / getMaxRequestsPerMinute());
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleRequest(): Promise<void> {
  const now = Date.now();
  if (now < nextRequestAt) {
    await sleep(nextRequestAt - now);
  }
  nextRequestAt = Math.max(Date.now(), nextRequestAt) + REQUEST_INTERVAL_MS;
}

function getRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;

  const parsedSeconds = parseInt(headerValue, 10);
  if (!Number.isNaN(parsedSeconds)) return Math.max(parsedSeconds, 1) * 1000;

  const parsedDate = Date.parse(headerValue);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(parsedDate - Date.now(), 1_000);
  }

  return null;
}

function getBackoffMs(attempt: number): number {
  const exponentialMs = Math.min(
    INITIAL_BACKOFF_MS * 2 ** attempt,
    MAX_BACKOFF_MS
  );
  const jitterMs = Math.floor(Math.random() * 500);
  return exponentialMs + jitterMs;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    await throttleRequest();
    const res = await fetch(url, init);
    if (res.status === 429) {
      const retryAfterMs = getRetryAfterMs(res.headers.get("Retry-After"));
      const waitMs = getBackoffMs(attempt);
      const waitSecs = Math.ceil(waitMs / 1000);
      if (retryAfterMs !== null) {
        const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
        console.log(
          `  Rate limited — backing off ${waitSecs}s before retry (server suggested ${retryAfterSecs}s)...`
        );
      } else {
        console.log(`  Rate limited — backing off ${waitSecs}s before retry...`);
      }
      nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
      await sleep(waitMs);
      continue;
    }
    return res;
  }
  throw new Error("Exceeded retry limit due to rate limiting");
}

async function fetchPage(
  token: string,
  params: Record<string, string>,
  cursor?: string
): Promise<ListResponse> {
  const url = new URL(`${BASE_URL}/api/v3/list/`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (cursor) {
    url.searchParams.set("pageCursor", cursor);
  }

  const res = await fetchWithRetry(url.toString(), {
    headers: { Authorization: `Token ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<ListResponse>;
}

async function fetchAll(
  token: string,
  params: Record<string, string>
): Promise<ReaderDoc[]> {
  const docs: ReaderDoc[] = [];
  let cursor: string | undefined;

  do {
    const page = await fetchPage(token, params, cursor);
    docs.push(...page.results);
    cursor = page.nextPageCursor ?? undefined;
    if (cursor) await sleep(DELAY_MS);
  } while (cursor);

  return docs;
}

/** Fetch all unread RSS items currently in the feed location. */
export async function fetchFeedDocs(token: string): Promise<ReaderDoc[]> {
  return fetchAll(token, { category: "rss", location: "feed" });
}

/** Fetch archived/read docs to compute read-rate signal. */
export async function fetchReadHistory(token: string): Promise<ReaderDoc[]> {
  return fetchAll(token, { category: "rss", location: "archive" });
}

/** Promote documents by moving them to "new" and optionally tagging them. */
export async function bulkUpdateDocs(
  token: string,
  docs: ReaderDoc[],
  opts: { location: string; tags: string[] }
): Promise<void> {
  const BATCH_SIZE = 50;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const body: Record<string, unknown> = {
      updates: batch.map((doc) => {
        const existingTags =
          doc.tags && typeof doc.tags === "object" ? Object.keys(doc.tags) : [];

        return {
          id: doc.id,
          location: opts.location,
          tags: [...new Set([...existingTags, ...opts.tags])],
        };
      }),
    };

    const res = await fetchWithRetry(`${BASE_URL}/api/v3/bulk_update/`, {
      method: "PATCH",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bulk update error ${res.status}: ${text}`);
    }

    if (res.status === 207) {
      const payload = (await res.json()) as {
        results?: Array<{ id: string; success: boolean; error?: string }>;
      };
      const failures =
        payload.results?.filter((result) => result.success === false) ?? [];
      if (failures.length > 0) {
        throw new Error(
          `Bulk update partial failure: ${failures
            .map((failure) => `${failure.id}: ${failure.error ?? "unknown error"}`)
            .join("; ")}`
        );
      }
    }

    if (i + BATCH_SIZE < docs.length) await sleep(DELAY_MS);
  }
}
