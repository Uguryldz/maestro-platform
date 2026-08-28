# RAPOR-B — Dalga B: Variants, Variant, Eval, Template, Doctemplate

The AI-configuration surface (M38/M43/M78/M83/M103r/M108) now genuinely works:
an admin creates and versions agent variants, gates a golden-ticket regression
with the M78 justified-pass flow, publishes analysis-template versions, and
uploads/downloads the corporate `.docx` — all admin-gated at the BFF, all
append-only where a version is involved.

## Which screens work now, and how

| Screen | Read | Write |
| --- | --- | --- |
| **Variants** | GET /variants (already wired) | **NEW** admin-only "Add variant" → POST /variants |
| **Variant** | GET /variants/:id (already wired) | **NEW** admin-only "Edit platform" → PUT /variants/:id, "Publish new version" → POST /variants/:id/versions |
| **Eval** | **`/eval` turned ON** — GET /eval now serves real data when an eval store is wired | **NEW** M78 gate: POST /eval/decisions (ship needs justification when regressed) |
| **Template** | GET /template (already wired) | POST /template/versions (already wired — verified, untouched) |
| **Doctemplate** | GET /doc-template (already wired) | **NEW** admin upload (POST /doc-template, raw `.docx`) + per-version download (GET /doc-template/versions/:v/file) — both wired into the UI |

Template's BFF and UI were already complete (read + append-only publish +
history + M83 pinning); doc-template's BFF was already complete and tested —
the gap there was purely the Studio UI (no upload/download), now closed.

## Endpoints: wired vs added

- **Wired (already existed, connected the UI / verified):** GET /variants,
  GET /variants/:id, GET /template, POST /template/versions, GET /doc-template,
  POST /doc-template, GET /doc-template/versions/:version/file.
- **Added (BFF):**
  - `POST /variants` — create + publish version 1
  - `PUT /variants/:variantId` — edit the platform overlay (non-versioned)
  - `POST /variants/:variantId/versions` — append an immutable version
  - `GET /eval` — moved out of the "refused" set into a real route (`routes/studio-eval.ts`)
  - `POST /eval/decisions` — record the M78 ship/block decision

## The `/eval` decision (why it stopped refusing)

`/eval` used to 503 because nothing PRODUCED golden-ticket data — the codebase's
core rule is that an unwired capability refuses rather than answer an empty page
that reads as "no regressions". That rule is preserved: I added a **producer**
(`EvalWriter`/`InMemoryEvalStore`), and `/eval` still refuses by name when no
store is wired (test: `studio-eval.test.ts` "REFUSES … never an empty pool").
`eval` moved out of `NO_PRODUCER_CAPABILITIES` in `routes/unwired.ts` — it is now
a wireable capability like `variants`/`pii`/`decisions`, not an absent one. The
demo-stack wires it; deploy does not yet (see interface requests).

## Append-only guarantee (M83)

Every version write appends `latest + 1` and **never mutates a published
version**:

- **Variant versions:** `InMemoryVariantCatalog.publishVersion` pushes a new
  version; `edit` changes only the platform overlay (model/persona are versioned
  and move only through a new version). The version number, author and timestamp
  are DERIVED server-side from the session and clock — never taken from the body
  (test: "derives the author and never takes it from the body"). Proven by
  "appends a new version without rewriting the previous one" (v1's note/persona
  unchanged after v2).
- **Template versions:** unchanged, still `latest + 1` in the store.
- **Doc-template versions:** unchanged, still `latest + 1`, bytes verbatim.

## Security (verifier checklist)

- **Every write is admin-gated at the BFF**, not just hidden in the UI:
  `requireAnyRole("admin")` on POST/PUT variants and POST /eval/decisions;
  doc-template upload was already admin-only. Tests assert 403 for members.
- **No privileged field from the body:** author/timestamp/version derived from
  session+clock; a body carrying `publishedBy` is ignored (tested).
- **Kill switch (M58):** all four writes call `assertWritable` first (tested 409
  `kill_switch`).
- **M78 anti-silent-pass:** shipping a regression with no justification is a 409
  `eval_regression_needs_justification`; the regression is re-checked against the
  STORED scores server-side, so a client cannot claim "no regression, ship it"
  (test: "checks the regression against the STORED scores, not the client's
  claim").
- **Persona input hardened:** bounded to 20k chars, control characters (except
  tab/newline) refused (tested).
- **Doc-template upload bounds unchanged** (8 MB, zip+Word-package check,
  filename sanitising) — not weakened.

## Files

**BFF (owned):** `read-studio.ts` (+VariantWriter/EvalReader/EvalWriter and the
optional `variantWriter`/`eval` in `StudioReadModels`), `variant-service.ts`
(new), `eval-service.ts` (new), `stores/variant-memory.ts` (new:
InMemoryVariantCatalog + InMemoryEvalStore), `routes/studio-variants.ts` (+writes),
`routes/studio-eval.ts` (new), `routes/studio-governance.ts` (removed the eval
stub), `routes/unwired.ts` (eval text + dropped from no-producer), `server.ts`
(register eval route), `index.ts` (export variant-memory).

**Studio (owned):** `screens/Variants.tsx`, `screens/Variant.tsx`,
`screens/Eval.tsx`, `screens/Doctemplate.tsx`, `api/client.ts` (+postBinary/getBlob),
`api/errors.ts` (+5 error codes).

**Shared (appended at end):** `packages/config/locales/{tr,en}.json`.

**Demo (nice-to-have):** `apps/demo-stack/src/seed/variants.ts` (new) +
`deps.ts` wiring, so the demo shows a real catalogue and a pending regression to
gate.

## Tests (offline, in-memory fakes, no network/live DB)

- `apps/bff/test/studio-variants-write.test.ts` — 17 tests: create/edit/version
  happy path, admin-gate (401/403), validation, kill switch, author-derivation,
  append-only, unwired-writer 503.
- `apps/bff/test/studio-eval.test.ts` — 11 tests: read, unwired 503, admin-gate,
  justified-pass required, clean/blocked no-justification, stored-score check,
  audit trail, kill switch, 404.
- `apps/studio/test/screens-agents.test.tsx` — 8 tests: catalogue render,
  admin-only controls, create posts typed fields (no forged author), regression
  verdict, ship-disabled-until-justified, justification posted, non-admin
  read-only, parseKnowledge.

BFF: **552 pass** (was 524). Studio: **226 pass**. Config: 23 pass. Demo: 47
pass. `pnpm lint` clean. All five typechecks green (bff/studio/deploy/demo/config).

## Interface requests (frozen contracts/ports — not changed here)

1. `AuditAction` (frozen) has no `VARIANT_PUBLISHED` / `EVAL_DECISION` /
   `DOC_TEMPLATE_UPLOADED` / `TEMPLATE_VERSION_PUBLISHED`. All four writes use
   `PARAM_CHANGED` with a `variant:` / `eval:` subject prefix, following the
   template/doc-template precedent. A dedicated action would let an auditor
   filter "who shipped a regression, and why" directly.
2. **Deploy wiring:** `PrismaVariantCatalog` is read-only. To make writes work in
   production, deploy needs a `VariantWriter` over `Variant`/`VariantVersion`
   (append a version row; the `configJson` already holds `knowledgeRefs`, and a
   `persona`/`note` column or `configJson` field is needed since the current
   schema stores neither) and an `EvalWriter` over new `GoldenTicket`/`EvalRun`
   tables. Until then, deploy's variant writes and `/eval` 503 by name — honest,
   consistent with the unwired principle.

## Not touched (coordination)

Users.tsx, Settings.tsx, Routing.tsx, Notify.tsx, Onboard.tsx and their BFF
routes (settings.ts, onboarding.ts, users part of studio-catalog.ts) — untouched.
Shared files got clean end-appends only.
