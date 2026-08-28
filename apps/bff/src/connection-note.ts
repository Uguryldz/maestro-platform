/**
 * How a connection's last-test note is stored.
 *
 * Its own module because BOTH probes write it — the connections panel's
 * explicit "Test et" (`routes/connections.ts`) and the health page's periodic
 * one (`connection-health.ts`). When only the first encoded its params, the
 * second overwrote a note carrying `?host=…` with a bare key, so refreshing
 * the health page silently degraded the other screen's diagnostic to a literal
 * `{host}`. One encoder, one shape, one story.
 */

/**
 * A stored test note: the catalog key, plus its params when they fit.
 *
 * Encoded as `key?a=b&c=d` — a query string, because it is exactly the shape
 * this needs (short, flat, string-to-string) and both sides already have a
 * parser for it. Params are dropped rather than truncated when the whole thing
 * would exceed the column: a note that renders with `{host}` still beats a note
 * that fails to write.
 */
export function noteWithParams(
  key: string,
  params: Readonly<Record<string, string>> | undefined,
): string {
  if (params === undefined || Object.keys(params).length === 0) return key;
  const encoded = `${key}?${new URLSearchParams(params).toString()}`;
  return encoded.length <= CONNECTION_NOTE_MAX ? encoded : key;
}

/** `Connection.lastTestNote` is `VarChar(128)`; the encoder must not exceed it. */
export const CONNECTION_NOTE_MAX = 128;

/**
 * An edit may not make a connection's config WORSE than it already is.
 *
 * The create path refuses a row whose kind cannot work (`assertConfigComplete`).
 * Applying that same rule to updates would have locked every row that predates
 * the requirement: the panel had no box for `jira_cloud.email` at all, so every
 * Jira Cloud connection in an existing install is missing it — and demanding it
 * on save would mean an operator fixing an unrelated typo gets a 400 they did
 * not cause and cannot understand.
 *
 * So the comparison is against the row as STORED. Filling the gap is allowed,
 * leaving it exactly as it was is allowed, and only opening a NEW gap is
 * refused. An install upgrades without a migration, and nobody can quietly turn
 * a working connection into a broken one.
 */
