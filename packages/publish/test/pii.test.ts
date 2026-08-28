import { describe, expect, it } from "vitest";
import { renderEvidenceSummaryMarkdown, type DocContext } from "../src/documents.js";
import { PublishRenderError } from "../src/errors.js";
import { createPublishRedactor } from "../src/pii.js";
import { createPublishPort } from "../src/register.js";
import { InMemoryPublishState, type PublishDeps } from "../src/types.js";
import {
  APP,
  EVIDENCE,
  EXEMPTIONS,
  FakeScmPort,
  FakeWorkPort,
  FakeWorkspace,
  RUN_ID,
  TICKET,
  fakeFetch,
  fakeSecrets,
  fakeTranslate,
  piiDeps,
  request,
  runContext,
} from "./helpers.js";

/**
 * Everything this port publishes is an ARTEFACT (M20/M82): a Confluence page,
 * a Jira comment and a commit in the application's git history. The third one
 * is effectively unerasable, so masking is not optional and is not per-driver.
 */
const CUSTOMER =
  "Musteri 12345678950 numarali TCKN ile TR330006100519786457841326 IBAN'ina, " +
  "4111 1111 1111 1111 kartindan gonderdi; iletisim: musteri@ornek.com, 0532 123 45 67.";

function wire(overrides: Partial<PublishDeps> = {}) {
  const work = new FakeWorkPort();
  const workspace = new FakeWorkspace();
  const scm = new FakeScmPort();
  const { fetchImpl, calls } = fakeFetch((req) =>
    req.method === "POST"
      ? { status: 200, body: { id: "900", version: { number: 1 }, body: { storage: { value: "" } } } }
      : { status: 200, body: { results: [] } },
  );
  const port = createPublishPort(
    ["jira", "confluence", "repo-docs"],
    { confluence: { baseUrl: "https://confluence.test", spaceKey: "MAESTRO", tokenRef: "secret/pat", retryDelayMs: 0 } },
    {
      translate: fakeTranslate(),
      runContext: runContext({ app: APP }),
      state: new InMemoryPublishState(),
      pii: piiDeps(),
      work: work.asPort(),
      scm: scm.asPort(),
      workspace,
      secrets: fakeSecrets(),
      fetchImpl,
      sleep: () => Promise.resolve(),
      ...overrides,
    },
  );
  return { port, work, workspace, calls };
}

const RAW = ["12345678950", "TR330006100519786457841326", "4111 1111 1111 1111", "musteri@ornek.com", "0532 123 45 67"];

describe("PII boundary of the publish path (M20/M82)", () => {
  it("masks the document before ANY target sees it", async () => {
    const { port, work, workspace, calls } = wire();

    await port.publish(request({ targets: ["jira", "confluence", "repo-docs"] }), `# Analiz\n\n${CUSTOMER}`);

    const jira = JSON.stringify(work.calls[0]?.args[1]);
    const page = JSON.stringify(calls.find((call) => call.method === "POST")?.body);
    const committed = [...workspace.files.values()].join("\n");

    for (const egress of [jira, page, committed]) {
      for (const raw of RAW) expect(egress).not.toContain(raw);
      expect(egress).toContain("TCKN_1");
      expect(egress).toContain("IBAN_1");
    }
    // The git commit is the one nobody can take back later.
    expect(committed).toContain("[EMAIL_1.");
  });

  it("is deterministic, so masking does not break idempotency", async () => {
    const first = wire();
    const second = wire();
    const document = `# Analiz\n\n${CUSTOMER}`;

    await first.port.publish(request({ targets: ["repo-docs"] }), document);
    await second.port.publish(request({ targets: ["repo-docs"] }), document);

    // A random session nonce would put a different token in every run and
    // every republish would burn a version / open a comment / add a commit.
    expect([...first.workspace.files.values()]).toEqual([...second.workspace.files.values()]);
  });

  it("keeps the approver identity the evidence package exists to record", async () => {
    const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };
    const redact = createPublishRedactor(piiDeps(), runContext());

    const out = await redact(request({ doc: "evidence_summary" }), renderEvidenceSummaryMarkdown(EVIDENCE, ctx));

    expect(out).toContain("tl.yilmaz@ugurbank.corp"); // listed exemption (M82)
    expect(out).toContain("analysis-template@1.4.0"); // the M83 pin
  });

  it("refuses to publish a document whose M83 pin masking would destroy", async () => {
    const ctx: DocContext = { translate: fakeTranslate(), locale: "tr", runId: RUN_ID, ticketKey: TICKET };
    const redact = createPublishRedactor(piiDeps(), runContext({ piiExemptions: [] }));

    // `analysis-template@1.4.0` is an address as far as the detectors care;
    // silently shipping `[EMAIL_1.…]` as the template pin would corrupt the
    // one field an auditor uses to know which standard applied.
    await expect(redact(request(), renderEvidenceSummaryMarkdown(EVIDENCE, ctx))).rejects.toThrow(PublishRenderError);
  });

  it("does not widen the exemption beyond the values it was given", async () => {
    const redact = createPublishRedactor(piiDeps(), runContext({ piiExemptions: EXEMPTIONS }));

    const out = await redact(request(), `<!-- maestro:doc template=analysis-template@1.4.0 -->\n\n${CUSTOMER}`);

    expect(out).toContain("analysis-template@1.4.0");
    expect(out).not.toContain("musteri@ornek.com");
  });

  it("masks an unrecognised data class with the strictest profile, not the loosest", async () => {
    // The class arrives from a Jira field, i.e. from outside; "acik" must not
    // be reachable by a webhook typing something the enum does not know.
    const unknown = createPublishRedactor(piiDeps(), runContext({ dataClass: "bilinmeyen-sinif" }));
    const open = createPublishRedactor(piiDeps(), runContext({ dataClass: "acik" }));

    await expect(unknown(request(), `metin ${CUSTOMER}`)).resolves.toContain("TCKN_1");
    // Even the loosest class of the default policy masks every identifier
    // (M18/M63): the axis that moves is the institution's account patterns.
    await expect(open(request(), `metin ${CUSTOMER}`)).resolves.not.toContain("12345678950");
  });

  it("reports counts to the audit hook without ever handing it a value", async () => {
    const seen: string[] = [];
    const redact = createPublishRedactor(
      {
        policy: piiDeps().policy,
        onMasked: (counts, dataClass) => seen.push(`${dataClass}:${String(counts.occurrences)}`),
      },
      runContext(),
    );

    await redact(request(), `# Analiz\n\n${CUSTOMER}`);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^gizli:[1-9]/); // no declared class → strictest
  });

  it("cannot be composed without a policy", () => {
    expect(() => wire({ pii: undefined as never })).toThrow(/deps\.pii\.policy/);
  });
});
