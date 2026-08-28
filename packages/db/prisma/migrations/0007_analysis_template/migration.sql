-- The ANALYSIS template designer (M108), and the reason it needs a table.
--
-- Until this migration the published analysis template lived in an
-- `InMemoryTemplateStore` inside the BFF process. That store enforces the
-- right rules, but it holds them in a JavaScript array: every restart dropped
-- the bank's template and `GET /template` answered 404 `no_template` again.
-- The designer screen therefore rendered "henüz yayında değil" forever, and a
-- run pinned to version 4 (M83) had nothing to pin to.
--
-- Not to be confused with 0006's `DocTemplateVersion`. That table holds the
-- Word file an analysis is RENDERED INTO; this one holds the questions the
-- analysis is asked to ANSWER. They version independently: restyling the
-- bank's document must not renumber what an analyst is required to write.

-- ---------------------------------------------------------------------------
-- AnalysisTemplateVersion
-- ---------------------------------------------------------------------------
-- `version` is the PRIMARY KEY rather than a surrogate id, for the same reason
-- as 0006: the rule it enforces is the point. The application computes
-- `latest + 1` and the database refuses the loser, so two authors pressing
-- save in the same second cannot both become version 5 with one draft lost.
CREATE TABLE "AnalysisTemplateVersion" (
    "version" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "sectionsJson" JSONB NOT NULL,
    "publishedBy" VARCHAR(128) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AnalysisTemplateVersion_pkey" PRIMARY KEY ("version")
);

-- Versions start at 1 and count up. A zero or negative version would sort
-- ahead of every real one under `ORDER BY version DESC` — i.e. it would become
-- the template every analysis in the bank is written against. Same guard, same
-- reasoning as `DocTemplateVersion_version_positive` in 0006.
ALTER TABLE "AnalysisTemplateVersion"
  ADD CONSTRAINT "AnalysisTemplateVersion_version_positive" CHECK ("version" > 0);

-- A template with no sections asks the analyst nothing, and an analysis
-- written against it would satisfy every required-section check by being
-- empty. The publish path already refuses one (`template_sections_required`);
-- this makes it true for a psql session and for a restore from a truncated
-- dump as well, which is the same argument 0002's guards make.
ALTER TABLE "AnalysisTemplateVersion"
  ADD CONSTRAINT "AnalysisTemplateVersion_sections_nonempty"
  CHECK (jsonb_typeof("sectionsJson") = 'array' AND jsonb_array_length("sectionsJson") > 0);

-- An unnamed template version cannot be referred to in a review or an audit
-- finding. The publish path trims and refuses empty; the database agrees.
ALTER TABLE "AnalysisTemplateVersion"
  ADD CONSTRAINT "AnalysisTemplateVersion_name_nonempty" CHECK (length(btrim("name")) > 0);

-- Append-only, enforced rather than intended.
--
-- The application never issues an UPDATE or a DELETE against this table, but
-- "never does" and "cannot" are different promises, and only the second one
-- survives a future maintenance script or an operator with a psql prompt. A
-- published version is the question an approved analysis was judged against
-- (M83); silently editing it would restate a decision a human already signed.
--
-- Reuses `maestro_append_only()` from 0002 rather than defining a second
-- function that says the same thing: one refusal message for every append-only
-- table in this database, and a fix to it fixes all of them.
CREATE TRIGGER "AnalysisTemplateVersion_append_only"
  BEFORE UPDATE OR DELETE ON "AnalysisTemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION maestro_append_only();

-- TRUNCATE is statement-level and fires no row trigger: without this,
-- `TRUNCATE "AnalysisTemplateVersion"` would empty an append-only table
-- without tripping the guard above. Same pair as 0002's.
CREATE TRIGGER "AnalysisTemplateVersion_append_only_truncate"
  BEFORE TRUNCATE ON "AnalysisTemplateVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION maestro_append_only();
