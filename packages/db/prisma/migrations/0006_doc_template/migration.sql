-- The corporate Word template (M103r/M109), and the documents rendered from it.
--
-- Two tables, and the split is deliberate: the template is the INPUT a document
-- owner uploads and the outputs are what the platform produced from it. Keeping
-- the produced documents in the same table would make "list the last 20
-- documents" a query over rows carrying a multi-megabyte `content` column.
--
-- What it adds:
--   1. DocTemplateVersion   — one row per uploaded .docx, append-only (M83)
--   2. DocTemplateOutputRow — documents produced, and the version each used

-- ---------------------------------------------------------------------------
-- 1. DocTemplateVersion
-- ---------------------------------------------------------------------------
-- `version` is the PRIMARY KEY rather than a surrogate id with a unique index,
-- because the rule it enforces is the point: two document owners uploading at
-- the same moment cannot both become version 3 with one file silently lost.
-- The application computes `latest + 1` and the database refuses the loser.
CREATE TABLE "DocTemplateVersion" (
    "version" INTEGER NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL,
    "uploadedBy" VARCHAR(128) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "stylesJson" JSONB NOT NULL,
    "placeholdersJson" JSONB NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "DocTemplateVersion_pkey" PRIMARY KEY ("version")
);

-- Versions start at 1 and count up. A zero or negative version would be a
-- caller that computed `latest + 1` from a bad `latest`, and it would sort
-- ahead of every real version in `ORDER BY version DESC` — i.e. it would
-- become the template every document is rendered against.
ALTER TABLE "DocTemplateVersion"
  ADD CONSTRAINT "DocTemplateVersion_version_positive" CHECK ("version" > 0);

-- An empty template is not a template. The upload path already refuses one;
-- this makes it true for every client, including a psql session and a restore
-- from a truncated dump — the same reasoning as 0002's guards.
ALTER TABLE "DocTemplateVersion"
  ADD CONSTRAINT "DocTemplateVersion_content_nonempty" CHECK (octet_length("content") > 0);

-- `sizeBytes` is what Studio displays; the bytes are what the generator reads.
-- If they disagree, the screen reports a file the platform does not have. The
-- application sets both from one buffer, so this only fires on a client that
-- wrote them separately — which is exactly the case worth catching.
ALTER TABLE "DocTemplateVersion"
  ADD CONSTRAINT "DocTemplateVersion_size_matches" CHECK ("sizeBytes" = octet_length("content"));

-- ---------------------------------------------------------------------------
-- 2. DocTemplateOutputRow
-- ---------------------------------------------------------------------------
-- `templateVersion` is deliberately NOT a foreign key to the table above.
-- Version 0 means "produced on the built-in fallback layout because no
-- corporate template was uploaded" — the M103r case where generation continues
-- with a visible warning — and it points at no row by design. A foreign key
-- would force that case to be spelled NULL, and a nullable column would then
-- have to mean both "fallback" and "we forgot to record it".
CREATE TABLE "DocTemplateOutputRow" (
    "id" VARCHAR(128) NOT NULL,
    "fileName" VARCHAR(400) NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "templateVersion" INTEGER NOT NULL,

    CONSTRAINT "DocTemplateOutputRow_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DocTemplateOutputRow"
  ADD CONSTRAINT "DocTemplateOutputRow_version_nonneg" CHECK ("templateVersion" >= 0);

-- The screen asks for the newest few; without this that is a sort of the whole
-- table, which grows by one row per published document forever.
CREATE INDEX "DocTemplateOutputRow_at_idx" ON "DocTemplateOutputRow"("at");
