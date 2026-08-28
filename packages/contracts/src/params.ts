import { z } from "zod";
import { IsoDateTime, NonEmpty } from "./common.js";

/**
 * Operational parameters live in the DB and are managed from Studio,
 * versioned + audited (M71). `.maestro.yaml` keeps only repo-native facts.
 */
export const ParamScope = z.enum(["global", "project", "application"]);
export type ParamScope = z.infer<typeof ParamScope>;

export const ParamType = z.enum(["string", "number", "boolean", "enum", "json"]);
export type ParamType = z.infer<typeof ParamType>;

export const ParamKey = z.string().regex(/^[a-z][a-z0-9_.]+$/);
export type ParamKey = z.infer<typeof ParamKey>;

export const ParamDefinition = z.object({
  key: ParamKey,
  scope: ParamScope,
  type: ParamType,
  /** guarded = 4-eyes: a change needs a second approver; enforced by the params service. */
  guarded: z.boolean(),
  enumValues: z.array(NonEmpty).optional(),
  descriptionKey: NonEmpty, // i18n key (M104) — no hardcoded UI text
  defaultValue: z.unknown(),
});
export type ParamDefinition = z.infer<typeof ParamDefinition>;

export const ParamChange = z.object({
  key: ParamKey,
  scopeRef: NonEmpty.nullable().default(null), // project/app id when scoped
  value: z.unknown(),
  version: z.number().int().positive(),
  changedBy: NonEmpty,
  approvedBy: NonEmpty.nullable().default(null), // required when definition.guarded
  at: IsoDateTime,
});
export type ParamChange = z.infer<typeof ParamChange>;
