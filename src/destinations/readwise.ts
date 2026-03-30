import type { Env, PipelineResult } from "../types.js";

const READWISE_SAVE_URL = "https://readwise.io/api/v3/save/";

/**
 * Save a processed item to Readwise Reader.
 * Uses the save URL endpoint which handles article extraction automatically.
 */
export async function sendToReadwise(result: PipelineResult, env: Env): Promise<void> {
  const body: Record<string, unknown> = {
    url: result.source_url,
    tags: result.tags,
  };

  if (result.title) {
    body.title = result.title;
  }

  if (result.summary) {
    body.notes = result.summary;
  }

  const res = await fetch(READWISE_SAVE_URL, {
    method: "POST",
    headers: {
      Authorization: `Token ${env.READWISE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Readwise save failed (${res.status}): ${text}`);
  }

  console.log(`[readwise] Saved ${result.source_url} with tags [${result.tags.join(", ")}]`);
}
