import { ScanConfigError } from "./errors.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Tags that move. A digest still wins at pull time, but `tool:latest@sha256:…`
 * invites the next editor to drop the digest, so it is refused outright (M27).
 * Compared lower-cased: `:LATEST` is the same moving target as `:latest`.
 */
const MUTABLE_TAGS = new Set([
  "latest", "edge", "stable", "nightly", "main", "master", "dev",
  "prod", "production", "release", "current", "head",
]);

/**
 * OCI distribution reference grammar for the part before `@`. Without this the
 * image NAME is never validated, and a configured value such as
 * `--privileged@sha256:…` or `--entrypoint=sh@sha256:…` is handed straight to
 * the container runtime as an OPTION rather than an image — option injection
 * from DB-held configuration (M71).
 */
const DOMAIN_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]{1,5})?`;
const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*";
const TAG = "[A-Za-z0-9_][A-Za-z0-9._-]{0,127}";
const IMAGE_NAME = new RegExp(
  `^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*(?::${TAG})?$`,
);

export interface PinnedImage {
  /** The reference as configured, e.g. `registry/tool@sha256:…`. */
  ref: string;
  /** Everything before the `@`. */
  name: string;
  /** `sha256:<64 hex>` — what lands in `ScanResult.imageDigest`. */
  digest: string;
}

/**
 * Parse a scanner image reference, refusing anything not pinned to a sha256
 * digest. Single gate for M27: config, factories and the driver all use it.
 */
export function parsePinnedImage(reference: string): PinnedImage {
  const ref = reference.trim();
  if (ref === "") throw new ScanConfigError("scanner image is empty — a digest-pinned reference is required (M27)");
  if (/\s/.test(ref)) throw new ScanConfigError(`scanner image "${ref}" contains whitespace`);

  const at = ref.indexOf("@");
  if (at < 0) {
    throw new ScanConfigError(
      `scanner image "${ref}" is not digest-pinned — expected <name>@sha256:<64 hex> (M27)`,
    );
  }
  if (ref.indexOf("@", at + 1) >= 0) throw new ScanConfigError(`scanner image "${ref}" has more than one "@"`);

  const name = ref.slice(0, at);
  const digest = ref.slice(at + 1);
  if (name === "") throw new ScanConfigError(`scanner image "${ref}" has no repository name`);
  if (!SHA256_DIGEST.test(digest)) {
    throw new ScanConfigError(`scanner image "${ref}" digest is not sha256:<64 hex> — got "${digest}"`);
  }
  if (!IMAGE_NAME.test(name)) {
    throw new ScanConfigError(
      `scanner image "${ref}" name "${name}" is not a valid OCI reference — a name that can be read as a container-runtime option is refused (M27)`,
    );
  }

  const tag = tagOf(name);
  if (tag !== undefined && MUTABLE_TAGS.has(tag.toLowerCase())) {
    throw new ScanConfigError(`scanner image "${ref}" carries the mutable tag ":${tag}" — pin by digest only (M27)`);
  }
  return { ref, name, digest };
}

/** Tag of the last path segment, if any. `host:5000/tool` has no tag. */
function tagOf(name: string): string | undefined {
  const segment = name.slice(name.lastIndexOf("/") + 1);
  const colon = segment.indexOf(":");
  return colon < 0 ? undefined : segment.slice(colon + 1);
}
