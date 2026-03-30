import type { ContentType, Env, PipelineResult } from "./types.js";
import { sendToReadwise } from "./destinations/readwise.js";
// import { sendToObsidian } from "./destinations/obsidian.js";

/**
 * Content-type → destination routing rules.
 *
 * | Content Type | Primary Destination | Tag/Folder            |
 * |---|---|---|
 * | podcast      | Obsidian vault      | transcripts/podcasts/ |
 * | blog         | Readwise Reader     | shared/blog           |
 * | video        | Obsidian vault      | transcripts/videos/   |
 * | unknown      | Readwise + DB       | shared/unsorted       |
 */
export async function routeResult(result: PipelineResult, env: Env): Promise<void> {
  switch (result.content_type as ContentType) {
    case "blog":
      await sendToReadwise(result, env);
      break;

    case "podcast":
      // Phase 3: sendToObsidian(result, env)
      // For now, fall through to Readwise
      await sendToReadwise(result, env);
      break;

    case "video":
      // Phase 3: sendToObsidian(result, env)
      await sendToReadwise(result, env);
      break;

    case "unknown":
    default:
      await sendToReadwise(result, env);
      break;
  }
}
