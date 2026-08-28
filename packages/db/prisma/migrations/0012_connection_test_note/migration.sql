-- A short, secret-free note from a connection's last live test.
--
-- The Connection table already records WHETHER the last test passed
-- (`lastTestOk`) and WHEN (`lastTestedAt`), but not WHY it failed. This adds the
-- outcome's catalog message KEY (e.g. "connection.test.unauthorized") so the
-- connector panel can show "✗ 401 unauthorized" instead of a bare red dot.
--
-- It is a KEY, never raw text: a driver's failure message routinely embeds the
-- connection string it could not open, and there is no reliable way to redact a
-- credential out of arbitrary text. Storing only the catalog key means a token
-- or DSN can never reach this column — the same discipline as the health
-- probe's `safeNote`.

ALTER TABLE "Connection" ADD COLUMN "lastTestNote" VARCHAR(128);
