import { Document, Packer, Paragraph, TextRun } from "docx";

/**
 * REAL `.docx` files, built with the same library that renders the platform's
 * documents.
 *
 * Hand-rolled bytes would prove nothing here. The upload path's whole job is to
 * tell a genuine Word package from something that only looks like one, and a
 * fixture built by hand would either be trivially accepted (a zip with the
 * right entry name and no Word XML inside it) or trivially rejected. These are
 * produced by `docx`'s own packer, so a test that accepts one is accepting the
 * kind of file a bank's document team actually produces.
 *
 * No network, no filesystem: `Packer.toBuffer` is pure.
 */

/**
 * A corporate template carrying the placeholders named in its paragraphs.
 *
 * Each token gets its own paragraph so the scan's "where is it" answer is
 * checkable, and so a token is not accidentally adjacent to another one.
 */
export async function buildDocx(tokens: readonly string[]): Promise<Uint8Array> {
  const doc = new Document({
    creator: "Uğur Bank",
    title: "Kurumsal analiz şablonu",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
      paragraphStyles: [
        {
          id: "KurumBaslik",
          name: "Kurum Başlık",
          basedOn: "Normal",
          run: { size: 32, bold: true },
        },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({
            style: "KurumBaslik",
            children: [new TextRun({ text: "Uğur Bank — Analiz Dokümanı" })],
          }),
          ...tokens.map(
            (token) =>
              new Paragraph({ children: [new TextRun({ text: `Alan: ${token}` })] }),
          ),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/**
 * A zip that is NOT a Word document: the right container, the wrong contents.
 *
 * This is the fixture that matters most. `PK\x03\x04` alone is a four-byte
 * check anybody passes by renaming a file, so the upload path has to open the
 * archive and look for `word/document.xml` — and this proves it does, rather
 * than proving it can spot a PDF.
 *
 * Built as a stored (uncompressed) single-entry zip by hand, because the point
 * is to produce an archive `docx` would never produce.
 */
export function buildNonWordZip(): Uint8Array {
  const name = Buffer.from("readme.txt", "latin1");
  const data = Buffer.from("bu bir word belgesi degil", "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.byteLength, 18);
  local.writeUInt32LE(data.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);
  local.writeUInt16LE(0, 28); // extra length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central file header
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.byteLength, 20);
  central.writeUInt32LE(data.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const localSize = local.byteLength + name.byteLength + data.byteLength;
  const centralSize = central.byteLength + name.byteLength;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // total entries
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  end.writeUInt16LE(0, 20); // comment length

  return new Uint8Array(
    Buffer.concat([local, name, data, central, name, end]),
  );
}

/** The zip CRC-32, so the archive above is well-formed rather than merely shaped right. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
