export const DISCORD_SAFE_LIMIT = 1900;
export const DEFAULT_MAX_DISCORD_CHUNKS = 8;
const TRUNCATION_SUFFIX = "\n\n[Reply truncated.]";

/**
 * Split text into Discord-safe chunks (~1900 chars), preferring paragraph
 * then newline then space boundaries.
 */
export function splitMessage(
  text: string,
  limit = DISCORD_SAFE_LIMIT,
  maxChunks = DEFAULT_MAX_DISCORD_CHUNKS,
): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new Error("maxChunks must be a positive integer");
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    if (chunks.length === maxChunks - 1) {
      const suffix = TRUNCATION_SUFFIX.length < limit ? TRUNCATION_SUFFIX : "…";
      const available = Math.max(0, limit - suffix.length);
      chunks.push(`${remaining.slice(0, available).trimEnd()}${suffix}`);
      return chunks;
    }

    const window = remaining.slice(0, limit);
    let cut =
      window.lastIndexOf("\n\n") >= 0
        ? window.lastIndexOf("\n\n")
        : window.lastIndexOf("\n") >= 0
          ? window.lastIndexOf("\n")
          : window.lastIndexOf(" ");

    if (cut < Math.floor(limit * 0.4)) {
      cut = limit;
    }

    const piece = remaining.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining && chunks.length < maxChunks) chunks.push(remaining);
  return chunks;
}
