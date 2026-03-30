import type { Env, Pipeline, PipelineResult } from "../types.js";

/**
 * Blog/article pipeline.
 *
 * Phase 1: Just saves the URL to Readwise with a shared/blog tag.
 * Phase 2: Will add LLM summarization via OpenRouter.
 */
export const blogPipeline: Pipeline = {
  async process(url: string, _env: Env, note?: string): Promise<PipelineResult> {
    const tags = ["shared", "shared/blog"];

    return {
      content_type: "blog",
      title: "",
      source_url: url,
      tags,
      metadata: {
        ...(note ? { user_note: note } : {}),
      },
    };
  },
};
