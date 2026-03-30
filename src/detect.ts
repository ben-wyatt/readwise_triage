import type { ContentType } from "./types.js";

const PODCAST_DOMAINS = new Set([
  "podcasts.apple.com",
  "open.spotify.com",
  "overcast.fm",
  "pocketcasts.com",
  "castro.fm",
  "podcasts.google.com",
  "pod.link",
]);

const VIDEO_DOMAINS = new Set([
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "m.youtube.com",
  "vimeo.com",
]);

/** Spotify episode URLs contain /episode/ in the path. */
function isSpotifyEpisode(url: URL): boolean {
  return url.hostname === "open.spotify.com" && url.pathname.startsWith("/episode");
}

/** Spotify can also be a song/album — only treat episodes as podcasts. */
function isSpotifyNonPodcast(url: URL): boolean {
  return url.hostname === "open.spotify.com" && !url.pathname.startsWith("/episode");
}

/**
 * Detect content type from a URL using layered heuristics.
 * Layer 1: domain matching (instant, no network)
 * Layer 2: OG tag sniffing (one fetch, future phase)
 */
export async function detectContentType(rawUrl: string): Promise<ContentType> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "unknown";
  }

  const hostname = parsed.hostname.replace(/^www\./, "");

  // Spotify special case — only episodes are podcasts
  if (hostname === "open.spotify.com") {
    if (isSpotifyEpisode(parsed)) return "podcast";
    if (isSpotifyNonPodcast(parsed)) return "unknown";
  }

  // Podcast domains
  if (PODCAST_DOMAINS.has(hostname)) return "podcast";

  // Video domains
  if (VIDEO_DOMAINS.has(hostname) || VIDEO_DOMAINS.has(parsed.hostname)) return "video";

  // TODO (Phase 2): OG tag sniffing for ambiguous URLs
  // For now, anything else is assumed to be a blog/article
  return "blog";
}
