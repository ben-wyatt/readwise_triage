import type { Pipeline } from "../types.js";
import { blogPipeline } from "./blog.js";
import { fallbackPipeline } from "./fallback.js";

const pipelines: Record<string, Pipeline> = {
  blog: blogPipeline,
  // podcast: podcastPipeline,   // Phase 3
  // video: videoPipeline,       // Phase 3
};

export function getPipeline(contentType: string): Pipeline {
  return pipelines[contentType] ?? fallbackPipeline;
}
