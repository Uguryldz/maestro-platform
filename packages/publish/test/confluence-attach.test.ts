import { describe, expect, it } from "vitest";
import { ConfluencePublishConfig, ConfluencePublisher } from "../src/drivers/confluence.js";
import { PublishHttpError, PublishRenderError, PublishResponseError } from "../src/errors.js";
import { InMemoryPublishState } from "../src/types.js";
import { fakeFetch, fakeSecrets, fakeTranslate, runContext, type RecordedRequest } from "./helpers.js";

/**
 * Attaching the generated `.docx`/`.pdf` to the ticket's living Confluence page
 * (M103r). Every call is faked — this suite never reaches a network.
 */

// Parsed rather than cast: the schema's defaults (timeoutMs, attempts) are
// part of the driver's behaviour and a hand-built object silently omits them.
const CONFIG = ConfluencePublishConfig.parse({
  baseUrl: "https://confluence.test",
  spaceKey: "MAESTRO",
  tokenRef: "secret/confluence-pat",
  retryDelayMs: 0,
});

const FILE = {
  name: "UGURPAY-123-analysis.docx",
  bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]),
  contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function publisher(handler: (req: RecordedRequest) => { status: number; body?: unknown; text?: string }) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const pub = new ConfluencePublisher(CONFIG, {
    secrets: fakeSecrets(),
    state: new InMemoryPublishState(),
    runContext: runContext(),
    translate: fakeTranslate(),
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { pub, calls };
}

describe("Confluence attachment upload (M103r)", () => {
  it("creates a new attachment and returns its id", async () => {
    const { pub, calls } = publisher((req) =>
      req.method === "GET"
        ? { status: 200, body: { results: [] } }
        : { status: 200, body: { results: [{ id: "att-1" }] } },
    );

    const result = await pub.attach("900", FILE);

    expect(result.attachmentId).toBe("att-1");
    const upload = calls.find((c) => c.method === "POST");
    expect(upload?.url).toBe("https://confluence.test/rest/api/content/900/child/attachment");
    // The uploaded part is the real file, with its name and media type.
    expect(upload?.form?.fileName).toBe(FILE.name);
    expect(upload?.form?.fileType).toBe(FILE.contentType);
    expect(upload?.form?.fileBytes).toBe(FILE.bytes.byteLength);
  });

  it("sends the XSRF header and lets fetch own the multipart boundary", async () => {
    const { pub, calls } = publisher((req) =>
      req.method === "GET" ? { status: 200, body: { results: [] } } : { status: 200, body: { id: "att-9" } },
    );

    await pub.attach("900", FILE);

    const upload = calls.find((c) => c.method === "POST");
    expect(upload?.headers["x-atlassian-token"]).toBe("nocheck");
    // A hand-written content-type would lose the boundary and Confluence would
    // reject the upload as malformed.
    expect(upload?.headers["content-type"]).toBeUndefined();
  });

  it("UPDATES an existing attachment instead of creating a second copy", async () => {
    // Confluence would otherwise keep both as `analiz.docx` and `analiz(1).docx`
    // and a reviewer could not tell which one the gate approved.
    const { pub, calls } = publisher((req) =>
      req.method === "GET"
        ? { status: 200, body: { results: [{ id: "att-existing" }] } }
        : { status: 200, body: { id: "att-existing" } },
    );

    const result = await pub.attach("900", FILE);

    expect(result.attachmentId).toBe("att-existing");
    expect(calls.find((c) => c.method === "POST")?.url).toBe(
      "https://confluence.test/rest/api/content/900/child/attachment/att-existing/data",
    );
  });

  it("refuses a zero-byte file rather than uploading a corrupt document", async () => {
    const { pub, calls } = publisher(() => ({ status: 200, body: { results: [] } }));

    await expect(pub.attach("900", { ...FILE, bytes: new Uint8Array() })).rejects.toThrow(PublishRenderError);
    expect(calls).toHaveLength(0);
  });

  it("fails loudly when the response carries no attachment id", async () => {
    const { pub } = publisher((req) =>
      req.method === "GET" ? { status: 200, body: { results: [] } } : { status: 200, body: { results: [] } },
    );

    await expect(pub.attach("900", FILE)).rejects.toThrow(PublishResponseError);
  });

  it("propagates an upload failure instead of reporting success", async () => {
    const { pub } = publisher((req) =>
      req.method === "GET" ? { status: 200, body: { results: [] } } : { status: 403, text: "no permission" },
    );

    await expect(pub.attach("900", FILE)).rejects.toThrow(PublishHttpError);
  });
});
