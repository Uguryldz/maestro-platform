/**
 * The file's bytes as plain base64 (no data: prefix), for the JSON upload
 * pipeline (`{ fileName, contentBase64 }`). Chunked so a big file does not blow
 * the argument list of `String.fromCharCode`. Shared by the general guidance
 * upload (Knowledge.tsx) and the per-agent upload (Variant.tsx).
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}
