# CLAUDE.md — Readwise Feed Ranker

This file documents the codebase structure, conventions, and development workflows for AI assistants working in this repository.

## Project Overview

**Readwise Feed Ranker** is a TypeScript CLI tool that triages a Readwise Reader inbox by scoring and ranking RSS feed items. It promotes only the highest-signal articles, preventing frequent publishers from overwhelming infrequent but valuable sources. A small Python helper script supports manual tagging operations.

## Repository Structure

```
readwise_triage/
├── src/
│   ├── index.ts          # Entry point: config loading, orchestration, JSON report
│   ├── types.ts          # All TypeScript interfaces and types
│   ├── readwise.ts       # Readwise API client (fetch, bulk update, rate limiting)
│   ├── scoring.ts        # Core ranking/scoring algorithm
│   └── scoring.test.ts   # Unit tests (Node built-in test runner)
├── python/
│   └── apply_tag.py      # Python helper for applying tags to Readwise documents
├── .env.example          # All supported environment variables with defaults
├── package.json          # npm scripts: start, test, typecheck
├── pyproject.toml        # Python project config (uv-managed)
├── tsconfig.json         # TypeScript config: ES2022, CommonJS, strict
└── README.md             # User-facing documentation
```

## Technology Stack

- **Primary language:** TypeScript (Node.js, ES2022, CommonJS modules)
- **Runtime executor:** `tsx` (runs `.ts` files directly without a build step)
- **Python utilities:** Python 3.12+ with `uv` for package management
- **External API:** Readwise Reader API v3

## Development Commands

```bash
# Run the ranker (defaults to DRY_RUN=true — safe to test)
npm start

# Run unit tests
npm test

# Type-check without emitting
npm run typecheck

# Run Python helper
python python/apply_tag.py
```

## Setup

1. Copy `.env.example` to `.env`
2. Set `READWISE_TOKEN` to your Readwise API token
3. Adjust optional config variables as needed
4. Run `npm start` to preview rankings (dry-run by default)
5. Set `DRY_RUN=false` to apply promotions

## Key Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `READWISE_TOKEN` | *(required)* | Readwise API auth token |
| `DRY_RUN` | `true` | When true, skips all API writes |
| `SCORING_WINDOW_DAYS` | `14` | Window for source frequency calculation |
| `MAX_ITEMS_PER_BUCKET` | `15` | Max items promoted per bucket |
| `SCORE_CURVE` | `sqrt` | Frequency penalty curve: `sqrt`, `log`, or `linear` |
| `JUST_IN_DAYS` | `14` | Freshness window for `just_in` bucket |
| `LONG_READ_MIN_WORDS` | `2500` | Word count threshold for `long_reads` bucket |
| `SHORT_BLOG_MAX_WORDS` | `1200` | Word count threshold for `short_blogs` bucket |
| `PROMOTE_TAG` | `triage` | Tag prefix applied to promoted items |
| `OUTPUT_JSON_PATH` | *(optional)* | Path to write the full JSON report |
| `ENABLE_READ_HISTORY` | `false` | Boost sources with high read completion rates |
| `ENABLE_LENGTH_SIGNAL` | `false` | Boost longer articles |

## Scoring Algorithm

Documents are assigned a composite score in `src/scoring.ts`:

```
final_score = frequency_score × (1 + bonus_sum)
```

**Components:**
- **Frequency score** — Inverse of how often a source posts; penalizes prolific sources using `sqrt`, `log`, or `linear` curve
- **Read history bonus** (optional) — 0–1 boost based on average completion rate for that source
- **Length bonus** (optional) — Sigmoid-based boost for articles exceeding a word count threshold
- **Recency bonus** — Small bonus for newer items
- **Bucket fit bonus** — Category-specific signal (e.g., strong recency for `just_in`, strong length for `long_reads`)

### Bucket Classification

Each document is assigned to exactly one bucket:

| Bucket | Criteria |
|---|---|
| `just_in` | Published within `JUST_IN_DAYS` |
| `long_reads` | Word count ≥ `LONG_READ_MIN_WORDS` |
| `short_blogs` | Word count ≤ `SHORT_BLOG_MAX_WORDS` |
| `general` | Everything else |

Buckets are independent: each selects its own top-N items. No cross-bucket quota borrowing occurs.

## API Client Conventions (`src/readwise.ts`)

- All Readwise API calls go through the `ReadwiseClient` class
- Rate limiting: configurable via `READWISE_MAX_REQUESTS_PER_MIN` (max 240/min)
- Retry on HTTP 429: exponential backoff starting at 2s, capped at 60s
- Pagination: handled automatically via cursor-based `GET /api/v3/list/`
- Bulk updates: batched at 50 documents per `PATCH /api/v3/bulk_update/` request

## Type System (`src/types.ts`)

All domain types live in `types.ts`. Key interfaces:

- `ReaderDoc` — Raw document from the Readwise API
- `ScoredDoc` — `ReaderDoc` extended with `_score`, `_bucket`, `_bucketRank`, `_globalRank`, and other underscore-prefixed scoring metadata
- `Config` — Parsed, validated runtime configuration
- `ScoringOptions` — Parameters passed into the scoring functions
- `ListResponse` — Readwise API list response envelope

**Convention:** Scoring metadata is attached to docs using underscore-prefixed properties (`_score`, `_bucket`, etc.) to distinguish them from API fields.

## Testing

Tests use the **Node.js built-in `test` module** (`node:test`) with `assert/strict`.

```bash
npm test
# runs: tsx --test src/scoring.test.ts
```

Test helpers in `scoring.test.ts`:
- `makeDoc(overrides?)` — Creates a minimal mock `ReaderDoc`
- `makeOptions(overrides?)` — Creates default `ScoringOptions`

When adding tests, follow this pattern and keep them focused on the scoring/ranking logic in `scoring.ts`.

## Python Helper (`python/apply_tag.py`)

A small utility to apply tags to Readwise documents via the Python `requests` library. Uses `python-dotenv` to load credentials from `.env`. Managed with `uv` (see `pyproject.toml`).

> Note: the current file contains a hardcoded document ID for testing at line 42 — clean this up before any production use.

## Output

Running `npm start` produces:
- Console output with per-bucket rankings and scores
- Optional JSON report at `OUTPUT_JSON_PATH` containing full scored document list with ranking metadata

## Key Conventions

1. **No build step required** — `tsx` executes TypeScript directly; do not add a compile step unless necessary.
2. **Dry-run by default** — `DRY_RUN=true` is the safe default; never change this default without discussion.
3. **Stateless design** — No local database; all state comes from the Readwise API at runtime.
4. **Independent buckets** — Do not add logic that borrows capacity between buckets; each bucket is intentionally self-contained.
5. **Strict TypeScript** — `strict: true` is enabled; avoid `any` types.
6. **Single responsibility** — Keep `scoring.ts` pure (no API calls), `readwise.ts` focused on HTTP, and `index.ts` as the thin orchestration layer.
