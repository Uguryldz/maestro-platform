import { inflateRawSync } from "node:zlib";

/**
 * The smallest zip reader that can answer "is this really a `.docx`, and what
 * is inside it".
 *
 * A `.docx` is an OPC package: a zip whose `word/document.xml` carries the
 * body and whose `word/styles.xml` carries the style definitions. To scan an
 * uploaded template for placeholders — and to REFUSE a file that only pretends
 * to be one — the BFF has to open those two entries.
 *
 * Written here rather than pulled in as a dependency because the need is two
 * entries out of a well-formed archive, and the alternative was adding a
 * general-purpose zip library to a bank's ingest path for a file an
 * unauthenticated-until-admin user uploads. Every bound below is deliberate:
 * this code reads attacker-influenced bytes.
 *
 * It reads the CENTRAL DIRECTORY, not the local headers. A local header may
 * carry a zeroed size with the real one in a trailing data descriptor, and a
 * reader that trusts it can be walked past the end of the archive or fed a
 * different file than the directory names — the classic zip-confusion trick.
 * The central directory is the archive's own index and is what every correct
 * implementation treats as authoritative.
 */

/** Only these two entries are ever inflated. A `.docx` has dozens; we need two. */
export const DOCX_DOCUMENT_ENTRY = "word/document.xml";
export const DOCX_STYLES_ENTRY = "word/styles.xml";

/**
 * Largest single entry this reader will inflate, and the cap that makes a zip
 * bomb boring: `word/document.xml` for a real corporate template is tens of
 * kilobytes, and 32 MB of decompressed XML is already far past any plausible
 * one. Without it a 50 KB upload could expand to gigabytes in a process that
 * also serves every other Studio request.
 */
export const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** Central-directory signatures. */
const END_OF_CENTRAL_DIR = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** `PK\x03\x04` — the first bytes of every zip, and so of every `.docx`. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export class DocxReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxReadError";
  }
}

interface CentralEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else this reader refuses. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Read one entry's decompressed bytes, or `null` when the archive has no such
 * entry. Throws `DocxReadError` when the archive itself is unusable — the two
 * are different answers: a `.docx` without `word/styles.xml` is merely a
 * template with no custom styles, while a truncated central directory is a
 * file that must not be accepted.
 */
export function readZipEntry(bytes: Uint8Array, entryName: string): Uint8Array | null {
  const entry = centralDirectory(bytes).find((candidate) => candidate.name === entryName);
  if (entry === undefined) return null;
  return inflateEntry(bytes, entry);
}

/** Every entry name in the archive — used to prove the package is a Word one. */
export function zipEntryNames(bytes: Uint8Array): readonly string[] {
  return centralDirectory(bytes).map((entry) => entry.name);
}

/**
 * Parse the central directory.
 *
 * The end-of-central-directory record sits at the tail, after a comment of up
 * to 64 KB, so it is found by scanning backwards for its signature — bounded
 * by that maximum comment length rather than by the whole file, which is what
 * keeps a hostile archive from making this a full-file scan for every upload.
 */
function centralDirectory(bytes: Uint8Array): readonly CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndRecord(bytes, view);

  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);

  if (offset + size > bytes.byteLength) {
    throw new DocxReadError("zip central directory points past the end of the file");
  }
  // A directory claiming more entries than could fit is a malformed archive,
  // and believing it would mean a loop that reads whatever follows in memory.
  if (count > size / 46 + 1) {
    throw new DocxReadError("zip central directory entry count does not fit its size");
  }

  const entries: CentralEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_FILE_HEADER) {
      throw new DocxReadError("zip central directory is truncated or corrupt");
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const nameStart = at + 46;
    if (nameStart + nameLength > bytes.byteLength) {
      throw new DocxReadError("zip entry name runs past the end of the file");
    }

    entries.push({
      // `latin1` rather than `utf8`: an entry name is compared against two
      // ASCII constants, and decoding hostile bytes as UTF-8 can fold distinct
      // byte sequences onto the same string.
      name: Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString("latin1"),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localHeaderOffset: view.getUint32(at + 42, true),
    });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const earliest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let at = bytes.byteLength - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIR) return at;
  }
  throw new DocxReadError("not a zip archive: no end-of-central-directory record");
}

/**
 * Inflate one entry, refusing anything the format does not require us to
 * support and anything that would cost more than a document can justify.
 */
function inflateEntry(bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new DocxReadError(
      `zip entry ${entry.name} declares ${String(entry.uncompressedSize)} bytes, over the ` +
        `${String(MAX_ENTRY_BYTES)} limit`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.byteLength || view.getUint32(header, true) !== LOCAL_FILE_HEADER) {
    throw new DocxReadError(`zip entry ${entry.name} has no local header where the directory says`);
  }

  // Name and extra lengths come from the LOCAL header: the two may legitimately
  // differ from the central copy, and the data starts after the local ones.
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;
  const finish = start + entry.compressedSize;
  if (finish > bytes.byteLength) {
    throw new DocxReadError(`zip entry ${entry.name} runs past the end of the file`);
  }

  const raw = bytes.subarray(start, finish);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) {
    throw new DocxReadError(`zip entry ${entry.name} uses unsupported compression ${String(entry.method)}`);
  }

  try {
    // `maxOutputLength` makes the bound the DECOMPRESSOR's, not a check after
    // the fact: a lying `uncompressedSize` cannot allocate its way past it.
    const inflated = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    throw new DocxReadError(`zip entry ${entry.name} could not be inflated: ${reason}`);
  }
}
