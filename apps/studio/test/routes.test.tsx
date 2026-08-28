import { describe, expect, it } from "vitest";
import { SCREEN_COMPONENTS } from "../src/app/screen-components.ts";
import { ALL_SCREEN_IDS, LOGIN_SCREEN, SCREENS, screenById } from "../src/app/screens.ts";

/**
 * The route table is the contract between this skeleton and the screen agents.
 * These tests fail if a screen is dropped, duplicated, or left without a
 * component — which is exactly the breakage a screen agent could cause by
 * editing the table instead of their own file.
 */

/**
 * Every view id in mock/index.html that is still its own screen. `onboard` and
 * `routing` were in the mock but merged into the `projects` page (three tabs),
 * so they are no longer standalone screen ids — see POST_MOCK_VIEW_IDS.
 */
const MOCK_VIEW_IDS = [
  "dash", "detail", "live", "clarify", "workmode", "fanout", "evidence",
  "jira", "params", "users", "yaml", "settings", "notify", "commands",
  "mcp", "runners", "sandbox", "health", "template", "doctemplate", "knowledge",
  "audit", "pii", "security", "issues", "cost", "variant",
  "variants", "eval", "cache", "greenfield", "help", "login",
] as const;

/**
 * Screens added AFTER the mock froze, or reshaped after it. `projects` is the
 * ONE page that gathers the three project-binding steps — add application, Jira
 * mapping & approval, listening rules — which used to be the separate
 * `onboard`, `routing` and `listening` screens (now its tabs; their old paths
 * redirect into it). `setup` is the guided wizard that walks a non-technical
 * operator through the SAME configuration in outcome language; `projects` stays
 * as the expert path, which is why both are here rather than one replacing the
 * other. Listed explicitly so the coverage check stays honest: a dropped or
 * accidental screen still fails.
 *
 * `pilot` (Dalga D) was here too — Studio's face for the retired pilot engine's
 * real-Jira flow, with `flow` as its process map. Both are gone with the engine;
 * their paths redirect to the Panel so old links still resolve.
 */
const POST_MOCK_VIEW_IDS = ["projects", "setup"] as const;
const EXPECTED_VIEW_IDS = [...MOCK_VIEW_IDS, ...POST_MOCK_VIEW_IDS];

describe("route table", () => {
  it("covers every screen in the mock, plus the intentional post-mock additions", () => {
    expect([...ALL_SCREEN_IDS].sort()).toEqual([...EXPECTED_VIEW_IDS].sort());
  });

  it("declares exactly the mock screens plus the post-mock additions", () => {
    expect(ALL_SCREEN_IDS).toHaveLength(EXPECTED_VIEW_IDS.length);
  });

  it("has no duplicate id or path", () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(SCREENS.length);
  });

  it("gives every in-shell screen a component", () => {
    for (const screen of SCREENS) {
      expect(SCREEN_COMPONENTS[screen.id], `missing component for ${screen.id}`).toBeTypeOf(
        "function",
      );
    }
  });

  it("has no orphan component without a table row", () => {
    for (const id of Object.keys(SCREEN_COMPONENTS)) {
      expect(screenById(id), `component ${id} has no SCREENS row`).toBeDefined();
    }
  });

  it("keeps login outside the shell", () => {
    expect(SCREENS.some((s) => s.id === "login")).toBe(false);
    expect(LOGIN_SCREEN.path).toBe("/login");
  });

  it("uses no leading slash on in-shell paths, so they nest under the shell", () => {
    for (const screen of SCREENS) {
      expect(screen.path.startsWith("/")).toBe(false);
    }
  });

  it("only exposes detail through a parameterised path", () => {
    expect(screenById("detail")?.path).toBe("detail/:ticket");
    expect(screenById("detail")?.navKey).toBeUndefined();
  });

  /**
   * The parameters screen is REACHABLE from the menu.
   *
   * It was pulled out with a note saying it would come back "once the engine
   * is connected", and the code that would bring it back was never written.
   * The engine has been connected for a while; the screen stayed hidden, so
   * the twenty-odd operational values an operator is supposed to tune —
   * including the sweep interval — lived on a page only someone typing the URL
   * by hand could reach.
   */
  it("keeps the parameters screen in the menu, not just on a route", () => {
    const params = screenById("params");
    expect(params?.path).toBe("params");
    expect(params?.navKey).toBe("nav.params");
    expect(params?.group).toBe("system");
  });
});
