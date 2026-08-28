import { z } from "zod";
import { RETENTION_YEARS_DEFAULT, RetentionClass } from "./keys.js";

const MAX_PRESIGN_SECONDS = 604800; // SigV4 hard limit: 7 days.

/**
 * s3-compat driver options (M5 BYOS). The target is a corporate S3-compatible
 * endpoint; MinIO/SeaweedFS are only the dev-compose default.
 */
export const S3StorageOptions = z.strictObject({
  /** Base endpoint, e.g. https://s3.corp.local or https://s3.corp.local:9000/gw */
  endpoint: z.url(),
  region: z.string().min(1).default("us-east-1"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "invalid bucket name"),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  /**
   * Corporate endpoints usually have no wildcard DNS/TLS, so path-style is the
   * default; AWS-style deployments switch to virtual-host.
   */
  addressing: z.enum(["path", "virtual-host"]).default("path"),
  /** Optional tenant prefix prepended to every key. Invisible to callers. */
  keyPrefix: z.string().default(""),
  /**
   * M57 WORM. Absent means the driver cannot honour objectLock puts and will
   * reject them instead of writing an unprotected object.
   */
  objectLock: z
    .strictObject({
      mode: z.enum(["COMPLIANCE", "GOVERNANCE"]),
      years: z.number().int().positive().default(RETENTION_YEARS_DEFAULT),
    })
    .optional(),
  /** Fallback class for keys outside the known layouts; the key wins (M65). */
  retentionClass: RetentionClass.default("evidence"),
  /** Emit x-amz-tagging on put (M56 lifecycle labelling). */
  tagging: z.boolean().default(true),
  maxPresignSeconds: z.number().int().positive().max(MAX_PRESIGN_SECONDS).default(3600),
  /**
   * Refuse a 2xx that carries no `x-amz-request-id`. Turn this off only for an
   * endpoint that is known to strip the header — it is what tells an S3 answer
   * apart from a proxy's own page.
   */
  requireAmzResponseHeaders: z.boolean().default(true),
});
export type S3StorageOptions = z.output<typeof S3StorageOptions>;
