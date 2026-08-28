import { describe, expect, it } from "vitest";
import { ConfluencePublisher, ConfluencePublishConfig } from "../src/drivers/confluence.js";
import { PublishConfigError, PublishHttpError, PublishRenderError, PublishResponseError } from "../src/errors.js";
import { InMemoryPublishState, type Translate } from "../src/types.js";
import {
  TICKET,
  fakeFetch,
  fakeSecrets,
  fakeTranslate,
  request,
  runContext,
  type RecordedRequest,
} from "./helpers.js";

const CONFIG = ConfluencePublishConfig.parse({
  baseUrl: "https://confluence.test/confluence",
  spaceKey: "MAESTRO",
  tokenRef: "secret/confluence-pat",
  retryDelayMs: 0,
});

const DOC = "# Analiz\n\nmetin";

interface StoredPage {
  id: string;
  title: string;
  version: number;
  value: string;
}

/**
 * In-memory Confluence: enough of the REST v1 content API to prove the driver's
 * create/update/version-conflict behaviour without a network.
 */
function server(pages: StoredPage[] = [], hooks: { beforePut?: () => void } = {}) {
  const store = new Map(pages.map((page) => [page.id, page]));
  let nextId = 1000;

  const handler = (req: RecordedRequest): { status: number; body?: unknown } => {
    const url = new URL(req.url);
    const byId = /\/rest\/api\/content\/(\d+)$/.exec(url.pathname);

    if (req.method === "GET" && byId) {
      const page = store.get(byId[1] ?? "");
      return page ? { status: 200, body: serialize(page) } : { status: 404 };
    }
    if (req.method === "GET") {
      const title = url.searchParams.get("title");
      const found = [...store.values()].filter((page) => page.title === title);
      return { status: 200, body: { results: found.map(serialize) } };
    }
    if (req.method === "POST") {
      const body = req.body as { title: string; body: { storage: { value: string } } };
      const page: StoredPage = {
        id: String(nextId++),
        title: body.title,
        version: 1,
        value: body.body.storage.value,
      };
      store.set(page.id, page);
      return { status: 200, body: serialize(page) };
    }
    // PUT
    hooks.beforePut?.();
    const body = req.body as { version: { number: number }; title: string; body: { storage: { value: string } } };
    const page = store.get(byId?.[1] ?? "");
    if (!page) return { status: 404 };
    if (body.version.number !== page.version + 1) {
      return { status: 409, body: { message: "version conflict" } };
    }
    page.version = body.version.number;
    page.value = body.body.storage.value;
    page.title = body.title;
    return { status: 200, body: serialize(page) };
  };

  return { handler, store };
}

function serialize(page: StoredPage) {
  return { id: page.id, version: { number: page.version }, body: { storage: { value: page.value } } };
}

function driverWith(handler: (req: RecordedRequest) => { status: number; body?: unknown }, translate?: Translate) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const state = new InMemoryPublishState();
  const driver = new ConfluencePublisher(CONFIG, {
    secrets: fakeSecrets(),
    state,
    runContext: runContext(),
    translate: translate ?? fakeTranslate(),
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { driver, calls, state };
}

describe("confluence publish driver (M47)", () => {
  it("creates the page when the space has none, in storage format", async () => {
    const { handler, store } = server();
    const { driver, calls } = driverWith(handler);

    const receipt = await driver.publish(request({ targets: ["confluence"] }), DOC);

    expect(receipt.target).toBe("confluence");
    expect(store.get(receipt.ref)?.value).toBe("<h1>Analiz</h1>\n<p>metin</p>");
    expect(store.get(receipt.ref)?.title).toBe("tr:publish.title.analysis(ticket=UGURPAY-123)");
    const post = calls.find((call) => call.method === "POST");
    expect(post?.headers["authorization"]).toBe("Bearer confluence-pat");
    expect(post?.body).toMatchObject({ space: { key: "MAESTRO" }, body: { storage: { representation: "storage" } } });
  });

  it("updates the same page on republish — one page, next version, no copy", async () => {
    const { handler, store } = server();
    const { driver } = driverWith(handler);

    const first = await driver.publish(request({ targets: ["confluence"] }), DOC);
    const second = await driver.publish(request({ targets: ["confluence"] }), `${DOC}\n\nek paragraf`);

    expect(second.ref).toBe(first.ref);
    expect(store.size).toBe(1);
    expect(store.get(first.ref)?.version).toBe(2);
    expect(store.get(first.ref)?.value).toContain("ek paragraf");
  });

  it("does not spend a version on an unchanged document", async () => {
    const { handler, store } = server();
    const { driver, calls } = driverWith(handler);

    const first = await driver.publish(request({ targets: ["confluence"] }), DOC);
    await driver.publish(request({ targets: ["confluence"] }), DOC);

    expect(store.get(first.ref)?.version).toBe(1);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("re-reads and retries when a concurrent editor wins the version race (409)", async () => {
    const pages: StoredPage[] = [
      { id: "500", title: "tr:publish.title.analysis(ticket=UGURPAY-123)", version: 3, value: "<p>eski</p>" },
    ];
    let raced = false;
    const { handler, store } = server(pages, {
      beforePut: () => {
        if (raced) return;
        raced = true;
        const page = store.get("500");
        if (page) page.version = 4; // somebody edited the page between GET and PUT
      },
    });
    const { driver, calls } = driverWith(handler);

    const receipt = await driver.publish(request({ targets: ["confluence"] }), DOC);

    expect(receipt.ref).toBe("500");
    expect(store.get("500")?.version).toBe(5);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("gives up loudly when the page keeps changing", async () => {
    const pages: StoredPage[] = [
      { id: "500", title: "tr:publish.title.analysis(ticket=UGURPAY-123)", version: 1, value: "<p>eski</p>" },
    ];
    const { handler, store } = server(pages, {
      beforePut: () => {
        const page = store.get("500");
        if (page) page.version += 1;
      },
    });
    const { driver, calls } = driverWith(handler);

    await expect(driver.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(PublishHttpError);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(CONFIG.maxVersionAttempts);
  });

  it("follows the remembered page id even when the page title changes", async () => {
    const { handler, store } = server();
    const { fetchImpl, calls } = fakeFetch(handler);
    const state = new InMemoryPublishState();
    let locale = "tr";
    const shifting: Translate = (_l, key, params) => `${locale}:${key}${params ? `(${params["ticket"] ?? ""})` : ""}`;
    const build = () =>
      new ConfluencePublisher(CONFIG, {
        secrets: fakeSecrets(),
        state,
        runContext: runContext(),
        translate: shifting,
        fetchImpl,
        sleep: () => Promise.resolve(),
      });

    const first = await build().publish(request({ targets: ["confluence"] }), DOC);
    locale = "en"; // the catalog wording changed between runs
    const second = await build().publish(request({ targets: ["confluence"] }), `${DOC} v2`);

    expect(second.ref).toBe(first.ref);
    expect(store.size).toBe(1);
    expect(calls.some((call) => call.method === "GET" && call.url.includes(`/content/${first.ref}?`))).toBe(true);
  });

  it("refuses to send an unauthenticated request when the token resolves empty", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { results: [] } }));
    const driver = new ConfluencePublisher(CONFIG, {
      secrets: {
        get: () => Promise.resolve("   "),
        set: () => Promise.resolve(),
        issueShortLived: () => Promise.reject(new Error("x")),
      },
      state: new InMemoryPublishState(),
      runContext: runContext(),
      translate: fakeTranslate(),
      fetchImpl,
    });

    await expect(driver.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(PublishConfigError);
    expect(calls).toHaveLength(0);
  });

  it("turns a server error into a typed failure, not a silent skip", async () => {
    const { driver } = driverWith(() => ({ status: 500, body: { message: "boom" } }));
    await expect(driver.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(PublishHttpError);
  });

  it("refuses a response that does not carry the fields it depends on", async () => {
    const { driver } = driverWith(() => ({ status: 200, body: { results: [{ id: "1" }] } }));
    await expect(driver.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(PublishResponseError);
  });

  it("validates its own configuration", () => {
    expect(() => ConfluencePublishConfig.parse({ baseUrl: "not-a-url", spaceKey: "M", tokenRef: "x" })).toThrow();
    expect(() => ConfluencePublishConfig.parse({ ...CONFIG, spaceKey: "BAD KEY" })).toThrow();
  });

  // The PAT travels in an Authorization header, so the scheme decides whether
  // it travels in clear text; `z.url()` alone waves `http:`/`ftp:` through.
  it("refuses a base URL that would carry the PAT in clear text", () => {
    const base = { spaceKey: "MAESTRO", tokenRef: "secret/pat" };
    expect(() => ConfluencePublishConfig.parse({ ...base, baseUrl: "http://confluence.test" })).toThrow();
    expect(() => ConfluencePublishConfig.parse({ ...base, baseUrl: "ftp://confluence.test" })).toThrow();
    expect(() => ConfluencePublishConfig.parse({ ...base, baseUrl: "javascript:alert(1)" })).toThrow();
    // ftp/file/javascript stay refused even with the development escape hatch.
    expect(() =>
      ConfluencePublishConfig.parse({ ...base, baseUrl: "file:///etc/passwd", allowInsecureHttp: true }),
    ).toThrow();
    expect(
      ConfluencePublishConfig.parse({ ...base, baseUrl: "http://localhost:8090", allowInsecureHttp: true }).baseUrl,
    ).toBe("http://localhost:8090");
  });

  it("fails the publish when the PUT lands on a page that is gone", async () => {
    // 404 used to be translated into `null` for EVERY method, so `update()`
    // saw no exception and the run got a "published" receipt for a page
    // Confluence never wrote — a forged line in the evidence package.
    const { driver, calls } = driverWith((req) =>
      req.method === "GET"
        ? { status: 200, body: { results: [{ id: "555", version: { number: 1 }, body: { storage: { value: "" } } }] } }
        : { status: 404 },
    );

    await expect(driver.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(PublishHttpError);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("keeps ONE live page per ticket — the state key is scoped like the title", async () => {
    const { handler, store } = server();
    const { fetchImpl } = fakeFetch(handler);
    const state = new InMemoryPublishState();
    const build = () =>
      new ConfluencePublisher(CONFIG, {
        secrets: fakeSecrets(),
        state,
        runContext: runContext(),
        translate: fakeTranslate(),
        fetchImpl,
        sleep: () => Promise.resolve(),
      });

    const first = await build().publish(request({ targets: ["confluence"] }), DOC);
    // A SECOND run of the same ticket (M54 rejection loop): the page it must
    // update is the one the first run created.
    const second = await build().publish(request({ runId: "run-20260808-0002", targets: ["confluence"] }), `${DOC} v2`);

    expect(second.ref).toBe(first.ref);
    expect(store.size).toBe(1);
    expect(await state.get(`publish:confluence:${TICKET}:analysis`)).toBe(first.ref);
  });

  it("adopts the existing page when Confluence says the title is taken (index lag)", async () => {
    const { handler, store } = server();
    let created = false;
    const { driver, calls } = driverWith((req) => {
      if (req.method === "POST" && !created) {
        // The page exists but the search index has not caught up yet.
        created = true;
        store.set("610", {
          id: "610",
          title: "tr:publish.title.analysis(ticket=UGURPAY-123)",
          version: 1,
          value: "<p>eski</p>",
        });
        return { status: 400, body: { message: "A page with this title already exists" } };
      }
      return handler(req);
    });

    const receipt = await driver.publish(request({ targets: ["confluence"] }), DOC);

    expect(receipt.ref).toBe("610");
    expect(store.size).toBe(1); // no duplicate page
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("refuses a document that renders to an empty page", async () => {
    const { handler } = server();
    const { driver, calls } = driverWith(handler);

    // An unterminated comment used to swallow the document and publish a page
    // with no content at all, under a success receipt.
    await expect(driver.publish(request({ targets: ["confluence"] }), "<!-- kapanmamis yorum")).rejects.toThrow(
      PublishRenderError,
    );
    expect(calls).toHaveLength(0);
  });
});
