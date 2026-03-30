import { detectContentType } from "./detect.js";
import { routeResult } from "./router.js";
import { getPipeline } from "./pipelines/index.js";
import type { Env, ShareRequest, ShareResponse } from "./types.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check — no auth
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }

    // All other routes require auth
    if (!authenticate(request, env)) {
      return json({ status: "error", message: "Unauthorized" }, 401);
    }

    // POST /share
    if (url.pathname === "/share" && request.method === "POST") {
      return handleShare(request, env, ctx);
    }

    return json({ status: "error", message: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

function authenticate(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, "");
  return token === env.SHARE_API_TOKEN;
}

async function handleShare(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: ShareRequest;
  try {
    body = await request.json<ShareRequest>();
  } catch {
    return json({ status: "error", message: "Invalid JSON body" }, 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return json({ status: "error", message: "Missing required field: url" }, 400);
  }

  // Detect content type (fast — domain matching first, hint override)
  const detectedType = body.content_type_hint ?? await detectContentType(body.url);

  // Respond immediately, process in background
  const response: ShareResponse = {
    status: "accepted",
    detected_type: detectedType,
    message: `Processing ${detectedType}: ${body.url}`,
  };

  // Async processing — doesn't block the response
  ctx.waitUntil(processInBackground(body, detectedType, env));

  return json(response, 202);
}

async function processInBackground(
  body: ShareRequest,
  contentType: string,
  env: Env,
): Promise<void> {
  try {
    const pipeline = getPipeline(contentType);
    const result = await pipeline.process(body.url, env, body.note);

    // Override title if the Share Sheet provided one
    if (body.title) {
      result.title = body.title;
    }

    await routeResult(result, env);
  } catch (err) {
    console.error(`[share-api] Processing failed for ${body.url}:`, err);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
