import { clip } from "./summary-format.js";

/**
 * Budgeted text assembly.
 *
 * Both the living summary and the bootstrap package are "as much of the record
 * as fits in N characters". Fitting by clipping the joined string is what the
 * verifier caught twice (Y-3, D-14): the tail of a document is where its most
 * recent — and sometimes its most important — lines are, so a blind clip drops
 * exactly the wrong ones. Here every section says what it is worth and where
 * it may lose lines, the cheapest section gives way first, and the sections
 * that must always be readable never give way at all.
 */
export interface TextBlock {
  /** Rendered once at least one line survives. `kept`/`dropped` are its own. */
  readonly heading?: (kept: number, dropped: number) => string;
  readonly lines: readonly string[];
  /** Cheapest goes first. `Infinity` means the block is never trimmed. */
  readonly value: number;
  /** Rendered above the surviving lines when some were dropped here. */
  readonly omitted?: (dropped: number) => string;
  /**
   * Rendered above the surviving lines regardless — for a block that was
   * already trimmed by its own budget before it got here. What was left out
   * is always stated: a section that quietly shrinks is a section a reader
   * cannot trust.
   */
  readonly note?: string;
  /**
   * Which end gives way. `head` (the default) is right for a chronological
   * list, where the oldest line is the cheapest; `tail` is right for a block
   * that is already ordered most-valuable-first, such as an embedded summary
   * or a file listing.
   */
  readonly from?: "head" | "tail";
}

interface BlockState {
  readonly block: TextBlock;
  kept: number;
}

function renderOne(state: BlockState): string[] {
  const { block, kept } = state;
  if (kept <= 0) return [];
  const dropped = block.lines.length - kept;
  const out: string[] = [];
  const heading = block.heading?.(kept, dropped);
  if (heading !== undefined) out.push("", heading);
  if (block.note !== undefined) out.push(block.note);
  if (dropped > 0 && block.omitted !== undefined) out.push(block.omitted(dropped));
  out.push(...(block.from === "tail" ? block.lines.slice(0, kept) : block.lines.slice(dropped)));
  return out;
}

function join(states: readonly BlockState[]): string {
  return states
    .flatMap((state) => renderOne(state))
    .join("\n")
    .replace(/^\n+/, "");
}

/**
 * Assemble `blocks` into at most `maxChars` characters.
 *
 * Deterministic: the same blocks and the same budget always produce the same
 * string, which is what makes the living summary reproducible years later.
 */
export function renderBlocks(blocks: readonly TextBlock[], maxChars: number): string {
  const states: BlockState[] = blocks.map((block) => ({ block, kept: block.lines.length }));
  let text = join(states);
  // Give way cheapest-first, one line at a time, until it fits.
  while (text.length > maxChars) {
    let victim: BlockState | undefined;
    for (const state of states) {
      if (state.kept <= 0 || state.block.value === Infinity) continue;
      if (victim === undefined || state.block.value < victim.block.value) victim = state;
    }
    if (victim === undefined) break;
    victim.kept -= 1;
    text = join(states);
  }
  // Last resort: the guaranteed blocks alone can still overflow a pathological
  // budget. A clipped section is context; an exception is context loss.
  return clip(text, maxChars);
}

/**
 * Keep the newest lines that fit in `budget`, always at least one.
 *
 * Used for sections with a reserved share of the budget — signed gate
 * decisions, above all: they are the core of the M33/M34 approval evidence and
 * must not be squeezed out by a long event log.
 */
export function keepNewest(
  lines: readonly string[],
  budget: number,
): { kept: readonly string[]; dropped: number } {
  let used = 0;
  let from = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const cost = (lines[i] as string).length + 1;
    if (used + cost > budget && from < lines.length) break;
    used += cost;
    from = i;
  }
  return { kept: lines.slice(from), dropped: from };
}
