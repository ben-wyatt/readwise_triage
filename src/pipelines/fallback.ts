import type { Env, Pipeline, PipelineResult } from "../types.js";

/**
 * Catch-all pipeline for unrecognized content types.
 * Saves to Readwise with shared/unsorted tag. No LLM processing.
 */
export const fallbackPipeline: Pipeline = {
  async process(url: string, _env: Env, note?: string): Promise<PipelineResult> {
    const tags = ["shared", "shared/unsorted"];

    return {
      content_type: "unknown",
      title: "",
      source_url: url,
      tags,
      metadata: {
        ...(note ? { user_note: note } : {}),
      },
    };
  },
};
