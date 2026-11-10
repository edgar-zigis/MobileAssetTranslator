import type { WorkItem } from './work-item.js';

export interface ChunkLimits {
  /** Most entries per request. */
  maxEntries: number;
  /** Most source characters (JSON payload) per request. */
  maxChars: number;
}

export const DEFAULT_LIMITS: ChunkLimits = { maxEntries: 60, maxChars: 6000 };

/** Share of a limit after which a chunk ends early at the next section comment. */
const SOFT_BREAK_FILL = 0.75;

/**
 * Splits work items into requests. A whole entry is the unit, so a string, a plural with all
 * its forms or an array with all its items always travels together. Chunks keep file order and
 * prefer to end where a new section (e.g. `MARK: Settings`) starts. An entry larger than the
 * character budget gets a chunk of its own.
 */
export function chunkItems(items: WorkItem[], limits: ChunkLimits = DEFAULT_LIMITS): WorkItem[][] {
  const chunks: WorkItem[][] = [];
  let current: WorkItem[] = [];
  let chars = 0;

  for (const item of items) {
    const fill = Math.max(current.length / limits.maxEntries, chars / limits.maxChars);
    const full = current.length >= limits.maxEntries || (current.length > 0 && chars + item.size > limits.maxChars);
    const sectionBreak = current.length > 0 && item.entry.section !== undefined && fill >= SOFT_BREAK_FILL;
    if (full || sectionBreak) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
