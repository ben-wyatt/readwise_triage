# Repository Guide

## Overview

This repository contains a TypeScript Readwise Reader feed ranker with two entry points:

- `src/index.ts`: local CLI for dry runs and JSON reports
- `worker/src/index.ts`: production Cloudflare scheduled Worker

Production is stateful and uses Cloudflare D1. It does not use GitHub Actions.

## Structure

```text
src/                         shared scoring, Reader client, CLI, and tests
worker/src/index.ts          scheduled Worker orchestration
worker/migrations/           D1 schema migrations
worker/wrangler.jsonc        production bindings, variables, and Cron Triggers
worker/worker-configuration.d.ts
                              generated Cloudflare binding types
python/apply_tag.py          manual tagging helper
```

## Commands

```sh
npm test
npm run typecheck
npm run worker:typecheck
npm run worker:types
npm start
npm run worker:deploy
```

Run the test suite and both type-checkers before deployment. Regenerate Worker types whenever bindings change.

## Production behavior

The Worker synchronizes RSS feed documents into D1, ranks active feed documents with the pure functions in `src/scoring.ts`, and promotes selected documents through Readwise's bulk-update endpoint.

The normal schedule is `17 10 * * *`. The hourly `15 * * * *` trigger advances a bounded bootstrap and becomes a no-op after `last_success_at` exists. The handler has an explicit cron allowlist; keep its constants synchronized with `worker/wrangler.jsonc` when schedules change.

Production uses `DRY_RUN=false`. Treat deployments and scheduled tests as live Reader mutations unless the configuration explicitly says otherwise.

Persistent Worker logs and invocation logs are enabled. D1's `triage_runs` table is the primary application-level execution record.

## Design boundaries

- `src/scoring.ts` stays pure and contains no API or database calls.
- Documents belong to exactly one of `just_in`, `long_reads`, `short_blogs`, or `general`.
- Buckets select independently and do not borrow unused capacity.
- Preserve existing Reader tags when promoting documents.
- Reader list and bulk-update requests must remain at or below 20 requests per minute.
- Incremental synchronization intentionally fetches all RSS locations so moves out of `feed` are reflected in D1.
- Never commit `.env`, `.dev.vars`, Cloudflare credentials, or Readwise tokens.

## Local CLI

The local CLI reads `.env`, defaults to dry-run mode, fetches the current RSS feed directly from Reader, prints a report, and optionally writes JSON. It is not the production scheduler.

## Testing

Tests use Node's built-in `node:test` module with `assert/strict`. Existing tests cover bucket selection and capacity behavior; Worker orchestration and integration coverage remain useful future additions.

## Python helper

`python/apply_tag.py` is a manual utility managed with `uv`. It is not part of production scheduling and currently contains a test document ID, so inspect it before use.
