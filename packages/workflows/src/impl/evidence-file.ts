import { createHash } from "node:crypto";
import type { EvidenceFile } from "@maestro/contracts";

/**
 * One file in the evidence package (M34), described and hashed together.
 *
 * The digest is taken over the SAME bytes that are stored — computed here,
 * next to the encoding, rather than by the caller from the string. A manifest
 * whose hash was taken over a different serialisation of the same object is
 * worse than no hash: it fails verification on a package that was never
 * altered, which is how an intact audit trail gets thrown away.
 */
export function evidenceFile(
  name: string,
  body: string,
  contentType: string,
): { file: EvidenceFile; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(body);
  return {
    file: {
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      contentType,
    },
    bytes,
  };
}
