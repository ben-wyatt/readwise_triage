import assert from "node:assert/strict";
import test from "node:test";

import { scoreAndRank } from "./scoring";
import { ReaderDoc, ScoringOptions } from "./types";

function makeDoc(
  id: string,
  title: string,
  ageDays: number,
  wordCount: number,
  siteName: string
): ReaderDoc {
  const publishedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);

  return {
    id,
    title,
    url: `https://example.com/${id}`,
    site_name: siteName,
    author: null,
    category: "rss",
    location: "feed",
    published_date: publishedAt.toISOString(),
    created_at: publishedAt.toISOString(),
    word_count: wordCount,
    reading_progress: 0,
    tags: {},
    summary: null,
  };
}

function makeOptions(maxItemsPerBucket: number): ScoringOptions {
  return {
    windowDays: 60,
    curve: "sqrt",
    readHistory: null,
    readHistoryWeight: 0.5,
    enableLength: false,
    lengthWeight: 0.2,
    justInDays: 14,
    longReadMinWords: 2500,
    shortBlogMaxWords: 1200,
    maxItemsPerBucket,
  };
}

test("selects top items independently within each bucket", () => {
  const docs = [
    makeDoc("just-in-best", "Just In Best", 1, 1500, "Fresh Source A"),
    makeDoc("just-in-next", "Just In Next", 3, 1500, "Fresh Source B"),
    makeDoc("long-best", "Long Best", 20, 4000, "Long Source A"),
    makeDoc("long-next", "Long Next", 25, 3200, "Long Source B"),
    makeDoc("short-best", "Short Best", 20, 600, "Short Source A"),
    makeDoc("short-next", "Short Next", 24, 800, "Short Source B"),
    makeDoc("general-best", "General Best", 20, 1800, "General Source A"),
    makeDoc("general-next", "General Next", 22, 2000, "General Source B"),
  ];

  const result = scoreAndRank(docs, makeOptions(1));

  assert.deepEqual(result.selectedByBucket.just_in.map((doc) => doc.id), [
    "just-in-best",
  ]);
  assert.deepEqual(result.selectedByBucket.long_reads.map((doc) => doc.id), [
    "long-best",
  ]);
  assert.deepEqual(result.selectedByBucket.short_blogs.map((doc) => doc.id), [
    "short-best",
  ]);
  assert.deepEqual(result.selectedByBucket.general.map((doc) => doc.id), [
    "general-best",
  ]);

  for (const [index, doc] of result.ranked.entries()) {
    assert.equal(doc._globalRank, index + 1);
  }

  for (let index = 1; index < result.ranked.length; index += 1) {
    assert.ok(
      (result.ranked[index - 1]._score ?? 0) >= (result.ranked[index]._score ?? 0)
    );
  }
});

test("does not fill empty bucket capacity from other buckets", () => {
  const docs = [
    makeDoc("long-1", "Long One", 20, 4200, "Long Source A"),
    makeDoc("long-2", "Long Two", 21, 3600, "Long Source B"),
    makeDoc("long-3", "Long Three", 22, 3000, "Long Source C"),
  ];

  const result = scoreAndRank(docs, makeOptions(2));
  const totalSelected = Object.values(result.selectedByBucket).reduce(
    (sum, bucketDocs) => sum + bucketDocs.length,
    0
  );

  assert.equal(totalSelected, 2);
  assert.deepEqual(result.selectedByBucket.long_reads.map((doc) => doc.id), [
    "long-1",
    "long-2",
  ]);
  assert.equal(result.selectedByBucket.just_in.length, 0);
  assert.equal(result.selectedByBucket.short_blogs.length, 0);
  assert.equal(result.selectedByBucket.general.length, 0);
});
