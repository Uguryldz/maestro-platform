/**
 * Minimal reader for the two S3 XML payloads this package consumes:
 * ListObjectsV2 results and error bodies. A full XML parser would be a new
 * runtime dependency for ~40 lines of work, so it is done here.
 */

import type { ResponseContext } from "./errors.js";
import { UnexpectedResponseError } from "./errors.js";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * A code point XML may actually carry. Anything above U+10FFFF makes
 * `String.fromCodePoint` throw, and a lone surrogate would poison every string
 * built from the result, so both are left as literal text instead.
 */
function codePoint(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return undefined;
  if (value >= 0xd800 && value <= 0xdfff) return undefined;
  return String.fromCodePoint(value);
}

export function decodeXmlText(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (raw, hex: string) => codePoint(parseInt(hex, 16)) ?? raw)
    .replace(/&#(\d+);/g, (raw, dec: string) => codePoint(Number(dec)) ?? raw)
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** First value of a direct child element, or undefined. */
export function readTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1]);
}

/**
 * Name of the first element in the document, namespace prefix stripped.
 * `<?xml …?>`, `<!DOCTYPE …>` and comments are skipped because none of them
 * start with a name character.
 */
export function rootElement(xml: string): string | undefined {
  const match = /<([A-Za-z_][A-Za-z0-9._:-]*)/.exec(xml);
  return match?.[1]?.split(":").pop();
}

export interface ListObjectsPage {
  keys: string[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
}

/**
 * Reads one ListObjectsV2 page.
 *
 * The root element is checked first: a corporate proxy that answers `200 OK`
 * with its own login page must not be read as "this prefix holds no objects" —
 * an auditor (M66) would be told the evidence never existed rather than that
 * the listing failed.
 */
export function parseListObjectsV2(context: ResponseContext, xml: string): ListObjectsPage {
  const root = rootElement(xml);
  if (root !== "ListBucketResult") {
    throw new UnexpectedResponseError(
      context,
      `expected a <ListBucketResult> document, got <${root ?? "no element at all"}>`,
      xml,
    );
  }
  const keys: string[] = [];
  for (const contents of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = readTag(contents[1] ?? "", "Key");
    if (key !== undefined) keys.push(key);
  }
  return {
    keys,
    isTruncated: readTag(xml, "IsTruncated") === "true",
    nextContinuationToken: readTag(xml, "NextContinuationToken"),
  };
}

/** S3 error bodies carry a machine-readable `<Code>`; returns it when present. */
export function parseErrorCode(xml: string): string | undefined {
  if (!xml.includes("<Error")) return undefined;
  return readTag(xml, "Code");
}
