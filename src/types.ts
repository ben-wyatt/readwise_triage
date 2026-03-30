// ---- Content types ----

export type ContentType = "podcast" | "blog" | "video" | "unknown";

// ---- Worker environment bindings ----

export interface Env {
  SHARE_API_TOKEN: string;
  READWISE_TOKEN: string;
  OPENROUTER_API_KEY: string;
  GITHUB_TOKEN: string;
  // KV namespace (uncomment when provisioned)
  // SHARE_KV: KVNamespace;
}

// ---- API request / response ----

export interface ShareRequest {
  url: string;
  title?: string;
  content_type_hint?: ContentType;
  note?: string;
}

export interface ShareResponse {
  status: "accepted" | "error";
  detected_type?: ContentType;
  message: string;
}

// ---- Pipeline types ----

export interface PipelineResult {
  content_type: ContentType;
  title: string;
  source_url: string;
  summary?: string;
  tags: string[];
  raw_content?: string;
  metadata: Record<string, string>;
}

export interface Pipeline {
  process(url: string, env: Env, note?: string): Promise<PipelineResult>;
}

// ---- Destination types ----

export type DestinationName = "readwise" | "obsidian" | "db";

export interface Destination {
  send(result: PipelineResult, env: Env): Promise<void>;
}
