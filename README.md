# Readwise Feed Ranker

Readwise Feed Ranker keeps a large Reader RSS inbox manageable by promoting a small, diverse set of articles instead of letting prolific publishers dominate the queue.

## What it does

The ranker reads documents with `category=rss` and `location=feed`, scores them, and assigns each document to one primary bucket:

- `just_in`: published within the freshness window
- `long_reads`: above the long-read word-count threshold
- `short_blogs`: below the short-blog word-count threshold
- `general`: everything else

Source frequency is the main signal: infrequent publishers receive a higher base score. Recency and bucket fit provide smaller bonuses, while read-history and length bonuses can be enabled explicitly. Each bucket selects up to `MAX_ITEMS_PER_BUCKET` documents independently.

In live mode, selected documents move to Reader's `new` location and retain their existing tags while gaining `triage` and `triage/<bucket>` tags.

This system currently ranks RSS documents; it does not perform LLM-based topical classification.

## Production architecture

Production runs entirely on Cloudflare as the `readwise-triage` scheduled Worker in [`worker/`](worker/). GitHub Actions is not used; the former `.github/workflows/triage.yml` scheduler has been removed.

The Worker has two UTC Cron Triggers:

- `17 10 * * *`: daily incremental sync, scoring, and promotion at 10:17 UTC (5:17am EST / 6:17am EDT)
- `15 * * * *`: bootstrap trigger that fetches five 100-document pages per run; after bootstrap completes it exits without calling Readwise

Only those two cron expressions are accepted by the Worker. An unrecognized or retired trigger is logged and ignored before it can touch D1 or Readwise.

Durable state lives in the `readwise-triage` D1 database:

- `triage_documents`: incrementally synchronized Reader document snapshot
- `triage_runs`: timing, counts, status, and errors for every execution
- `triage_decisions`: bucket, score, rank, and promotion status for selected documents
- `triage_state`: bootstrap cursor and last successful synchronization timestamp

Persistent Cloudflare invocation logs are enabled at 100% sampling. The encrypted `READWISE_TOKEN` Worker secret is the only production credential used at runtime.

### Current production state

The D1 bootstrap completed on September 13, 2026, and live scheduled execution was verified end to end against Readwise. The normal daily and hourly triggers are deployed; the hourly trigger is now a safe no-op unless a new database must be bootstrapped.

## Configuration

Production configuration is committed in [`worker/wrangler.jsonc`](worker/wrangler.jsonc). Local credentials belong in ignored `.env` or `.dev.vars` files.

| Variable | Default | Purpose |
|---|---:|---|
| `DRY_RUN` | `false` in production | Skip Reader updates when `true` |
| `SCORING_WINDOW_DAYS` | `14` | Window used to count source publishing frequency |
| `MAX_ITEMS_PER_BUCKET` | `15` | Maximum selected documents per bucket |
| `SCORE_CURVE` | `sqrt` | Frequency penalty: `sqrt`, `log`, or `linear` |
| `JUST_IN_DAYS` | `14` | Freshness window for `just_in` |
| `LONG_READ_MIN_WORDS` | `2500` | Minimum size for `long_reads` |
| `SHORT_BLOG_MAX_WORDS` | `1200` | Maximum size for `short_blogs` |
| `PROMOTE_TAG` | `triage` | Base tag added during promotion |
| `READWISE_MAX_REQUESTS_PER_MIN` | `20` | Reader API request cap |
| `BOOTSTRAP_MAX_PAGES_PER_RUN` | `5` | Pages fetched by each bootstrap invocation |

The Reader list and bulk-update endpoints are limited to 20 requests per minute, so the Worker clamps its throughput to that value and honors `Retry-After` responses.

## Development

Install dependencies and validate both runtimes:

```sh
npm ci
npm test
npm run typecheck
npm run worker:typecheck
```

The local CLI remains useful for exploratory dry runs:

```sh
cp .env.example .env
# Add READWISE_TOKEN to .env; DRY_RUN defaults to true.
npm start
```

It prints the ranking and writes the complete report to `OUTPUT_JSON_PATH`.

## Deploying

From a clean checkout:

```sh
npm ci
npm test
npm run typecheck
npm run worker:types
npm run worker:typecheck
npx wrangler d1 migrations apply readwise-triage --remote -c worker/wrangler.jsonc
npx wrangler secret put READWISE_TOKEN -c worker/wrangler.jsonc
npm run worker:deploy
```

Regenerate [`worker/worker-configuration.d.ts`](worker/worker-configuration.d.ts) whenever Worker bindings change. Changes to cron expressions must be made in both [`worker/wrangler.jsonc`](worker/wrangler.jsonc) and the cron allowlist in [`worker/src/index.ts`](worker/src/index.ts).

## Operations

Inspect recent executions:

```sh
npx wrangler d1 execute readwise-triage --remote -c worker/wrangler.jsonc \
  --command "SELECT * FROM triage_runs ORDER BY started_at DESC LIMIT 20"
```

Tail live Worker events:

```sh
npx wrangler tail readwise-triage -c worker/wrangler.jsonc
```

## Possible future work

- Add email newsletters and explicitly saved articles as configurable source categories.
- Use completion history as an active ranking signal.
- Add optional LLM-based topic tags such as AI, China, or politics.
- Add Worker-level tests for bootstrap, incremental synchronization, and failure recovery.

[Readwise Reader API documentation](https://readwise.io/reader_api)
