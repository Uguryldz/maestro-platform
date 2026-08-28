import type { MaestroPlatform } from "@maestro/mcp-servers";
import type { ResolvedDeps } from "../deps.js";
import { operateHalf } from "./operate.js";
import { proposeHalf } from "./propose.js";
import { readHalf } from "./read.js";

/**
 * The BFF's implementation of `MaestroPlatform` (M101).
 *
 * maestro-mcp injects this, which is the whole point: the MCP surface and
 * Studio read the same runs from the same read models through the same RBAC,
 * so there is no second source of truth that could tell an AI a run is at a
 * different step than the one a human is looking at.
 *
 * Split by what the methods DO rather than by which tool calls them: the read
 * half answers questions, the operate half changes a run and carries the
 * kill-switch and project checks that come with that, and the propose half
 * files changes that only a second human can make real. No half has a method
 * that closes a gate, and that absence is structural — M101's guarantee does
 * not rest on a name check somewhere else.
 */
export function bffPlatform(deps: ResolvedDeps): MaestroPlatform {
  return { ...readHalf(deps), ...operateHalf(deps), ...proposeHalf(deps) };
}

export { scopeOf, usernameOf } from "./actor-scope.js";
export { OPERATE_METHODS, type OperateHalf } from "./operate.js";
export { FOUR_EYES_GROUP, KILL_SWITCH_PROPOSAL_KEY } from "./propose.js";
export { PLATFORM_MAX_LIMIT, clampLimit } from "./read.js";
export { NO_RUN_NOTE, runOf } from "./run-lookup.js";
