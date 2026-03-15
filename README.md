# Readwise Feed Ranker

Readwise Feed Ranker helps keep your Reader inbox focused by scoring feed items and promoting only the highest-signal articles, so frequent publishers do not drown out infrequent but valuable sources.

The algorithm first computes a source frequency score from recent publishing volume (using a configurable curve) and then classifies each feed item into one primary bucket:

- `just_in`: recent items inside the freshness window
- `long_reads`: items above the long-read word-count threshold
- `short_blogs`: items below the short-blog threshold
- `general`: everything else

Items are ranked within their bucket using a continuous score built from source frequency, optional read-history, optional length, and a small recency component. Each bucket independently selects up to its configured maximum number of items, with no cross-bucket quota balancing or fallback pool.

- `READWISE_TOKEN`: Required Readwise API token used to read and update documents.
- `SCORING_WINDOW_DAYS`: Number of past days used when counting each source's post frequency.
- `MAX_ITEMS_PER_BUCKET`: Maximum number of items selected from each bucket per run.
- `SCORE_CURVE`: Frequency-penalty curve (`sqrt`, `log`, or `linear`) applied to prolific sources.
- `ENABLE_READ_HISTORY`: Enables a completion-rate boost based on what you typically finish reading.
- `READ_HISTORY_WEIGHT`: Strength of the read-history boost when enabled.
- `ENABLE_LENGTH_SIGNAL`: Enables a mild boost for longer articles.
- `LENGTH_SIGNAL_WEIGHT`: Strength of the length-based boost when enabled.
- `JUST_IN_DAYS`: Recency window used for the `just_in` bucket.
- `LONG_READ_MIN_WORDS`: Minimum word count for the `long_reads` bucket.
- `SHORT_BLOG_MAX_WORDS`: Maximum word count for the `short_blogs` bucket.
- `PROMOTE_TAG`: Optional base tag added to promoted documents. Selected items also receive a bucket tag like `triage/just_in`.
- `DRY_RUN`: If `true`, prints planned promotions without changing Readwise.
- `OUTPUT_JSON_PATH`: File path where full ranking results are saved as JSON.
- `READWISE_MAX_REQUESTS_PER_MIN`: Request throughput cap for API calls (default `240`, max `240`).

Run the program with `npm start`.

The output JSON now includes the full global ranking, full within-bucket rankings, bucket summaries, and the selected items for each bucket.

Readwise API calls are paced to stay under the documented cap, and `429` responses now use a short exponential backoff that starts around `2s` and ramps up on repeated retries instead of immediately sleeping for a long fixed interval.

[API Docs](https://readwise.io/reader_api)

## thoughts on implementation

I am taking an outcomes-oriented approach to this design -- like any good vibe code.

What do I want from my algo:
- a few different buckets. one for long reads, one for short blogs (tyler cowen)
- upweigh infrequent posters
- stay current: a "just-in" bucket that only shows the best posts from the last 2 weeks
- each bucket should have at max 15 items and they should be the most relevant
- the cron job should populate these buckets once a day.
- I want more signals that I can work against. classification, maybe traffic/popularity
- could I do some amount of LLM pre-parsing to get rid of dumb shit?
- the proper way to set this up is to apply tags to documents and then in the readwise app create filtered views 

## next steps

think through design spec: just_in, long_reads, short_blogs, general.

assign classification tags using LLM on the document summary: topics should include AI, China, politics, etc etc. use 