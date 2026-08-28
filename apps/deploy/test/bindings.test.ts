import { DataClass, WorkMode } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  LIVE_BINDING_STATES,
  PrismaBindingWriter,
  PrismaJiraProjectBindings,
  triggerModeOf,
  type BindingDelegate,
  type BindingRow,
  type BindingUpsertDelegate,
  type BindingWriteRow,
} from "../src/stores/bindings.js";

/**
 * O-1: the composition root used to pass an EMPTY binding list, so every Jira
 * webhook the bank delivered resolved to `null` and was dropped. These tests
 * cover the store that replaced it — and in particular the two narrowings it
 * has to perform, because both of them fail towards "do less", which is the
 * only safe direction when the alternative is starting AI work on a ticket.
 */

const AT_REST: BindingRow = {
  projectKey: "UGURPAY",
  trigger: "auto",
  triggerLabel: "maestro",
  defaultsJson: { appId: "ugurpay", mode: "full_auto", dataClass: "dahili" },
  state: "active",
};

function storeOf(...rows: readonly BindingRow[]): PrismaJiraProjectBindings {
  const delegate: BindingDelegate = {
    findUnique: ({ where }) =>
      Promise.resolve(rows.find((row) => row.projectKey === where.projectKey) ?? null),
  };
  return new PrismaJiraProjectBindings(delegate);
}

describe("PrismaJiraProjectBindings", () => {
  it("resolves a bound project from the row", async () => {
    const binding = await storeOf(AT_REST).resolve("UGURPAY");

    expect(binding).toEqual({
      projectKey: "UGURPAY",
      active: true,
      triggerMode: "auto",
      appId: "ugurpay",
      mode: "full_auto",
      dataClass: "dahili",
    });
  });

  /** M102's rule survives the change: an unbound project is still dropped. */
  it("resolves an unbound project to null", async () => {
    expect(await storeOf(AT_REST).resolve("UGURWEB")).toBeNull();
  });
});

describe("binding state narrowing", () => {
  /**
   * The one that matters. A dry-run binding exists so an operator can watch
   * what WOULD happen; reading it as live turns the rehearsal into real work
   * on a bank's ticket.
   */
  it("does not treat a dry-run binding as active", async () => {
    const binding = await storeOf({ ...AT_REST, state: "dry_run" }).resolve("UGURPAY");

    expect(binding?.active).toBe(false);
  });

  it.each(["draft", "paused", "unbound"])("does not treat %s as active", async (state) => {
    const binding = await storeOf({ ...AT_REST, state }).resolve("UGURPAY");

    expect(binding?.active).toBe(false);
  });

  it("treats only the active state as active", () => {
    expect(LIVE_BINDING_STATES).toEqual(["active"]);
  });
});

describe("trigger mode narrowing", () => {
  /** `auto` is the only mode that starts a run without being asked (M48a). */
  it("maps auto to auto", () => {
    expect(triggerModeOf("auto")).toBe("auto");
  });

  it.each(["label", "command"])("maps %s to opt_in", (trigger) => {
    expect(triggerModeOf(trigger)).toBe("opt_in");
  });

  /** A mode this code does not understand must wait to be asked. */
  it("maps an unrecognised trigger to opt_in rather than auto", () => {
    expect(triggerModeOf("some_future_mode")).toBe("opt_in");
  });
});

describe("defaultsJson is a JSON column, so its contents are unknown", () => {
  /**
   * A corrupt column must not be the reason an AI gets a free hand, nor the
   * reason a secret ticket is treated as public.
   */
  it("falls back to human_only and gizli when the column is unreadable", async () => {
    const binding = await storeOf({ ...AT_REST, defaultsJson: "not an object" }).resolve("UGURPAY");

    expect(binding?.mode).toBe("human_only");
    expect(binding?.dataClass).toBe("gizli");
    expect(binding?.appId).toBeNull();
  });

  it("rejects a mode that is not in the contract", async () => {
    const binding = await storeOf({
      ...AT_REST,
      defaultsJson: { mode: "yolo", dataClass: "acik" },
    }).resolve("UGURPAY");

    expect(binding?.mode).toBe("human_only");
    // The readable half is still honoured — the fallback is per field.
    expect(binding?.dataClass).toBe("acik");
  });

  it("rejects a data class that is not in the contract", async () => {
    const binding = await storeOf({
      ...AT_REST,
      defaultsJson: { mode: "ai_assist", dataClass: "cok_gizli" },
    }).resolve("UGURPAY");

    expect(binding?.dataClass).toBe("gizli");
    expect(binding?.mode).toBe("ai_assist");
  });

  it("treats a null appId as the assignment queue rather than inventing one", async () => {
    const binding = await storeOf({
      ...AT_REST,
      defaultsJson: { mode: "ai_assist", dataClass: "dahili" },
    }).resolve("UGURPAY");

    expect(binding?.appId).toBeNull();
  });
});

/**
 * The vocabularies are literals in the driver so it compiles alone. These pin
 * them against the frozen contract, so a value added upstream fails the suite
 * rather than the deployment — the same discipline `profile.test.ts` applies to
 * driver ids.
 */
describe("the literal vocabularies match the contract", () => {
  it("accepts every WorkMode the contract defines", async () => {
    for (const mode of WorkMode.options) {
      const binding = await storeOf({
        ...AT_REST,
        defaultsJson: { mode, dataClass: "dahili" },
      }).resolve("UGURPAY");
      expect(binding?.mode, `${mode} was rejected`).toBe(mode);
    }
  });

  it("accepts every DataClass the contract defines", async () => {
    for (const dataClass of DataClass.options) {
      const binding = await storeOf({
        ...AT_REST,
        defaultsJson: { mode: "ai_assist", dataClass },
      }).resolve("UGURPAY");
      expect(binding?.dataClass, `${dataClass} was rejected`).toBe(dataClass);
    }
  });
});

/**
 * The writer that turns an approved onboarding proposal into a binding (M93).
 *
 * The delegate is a Map keyed by projectKey — the `JiraProjectBinding` table. The
 * properties under test: `bind` upserts (create then overwrite), it writes
 * `defaultsJson` in exactly the `{appId,mode,dataClass}` shape the reader parses,
 * and a binding it writes RESOLVES cleanly through `PrismaJiraProjectBindings`
 * (the round-trip that proves the writer and reader agree on the column shape).
 */
function writerOf(): { writer: PrismaBindingWriter; rows: Map<string, BindingWriteRow> } {
  const rows = new Map<string, BindingWriteRow>();
  const delegate: BindingUpsertDelegate = {
    upsert: (args) => {
      const existing = rows.get(args.where.projectKey);
      rows.set(
        args.where.projectKey,
        existing === undefined ? args.create : { ...existing, ...args.update },
      );
      return Promise.resolve(rows.get(args.where.projectKey));
    },
  };
  return { writer: new PrismaBindingWriter(delegate), rows };
}

describe("PrismaBindingWriter", () => {
  it("writes a binding whose defaultsJson the reader parses back", async () => {
    const { writer, rows } = writerOf();
    await writer.bind({
      projectKey: "OPS",
      trigger: "label",
      state: "active",
      defaults: { appId: "Uguryldz/maestro-pilot", mode: "human_lead", dataClass: "gizli" },
    });

    // Round-trip through the reader over the same row: writer + reader agree.
    const row = rows.get("OPS")!;
    const binding = await new PrismaJiraProjectBindings({
      findUnique: () => Promise.resolve({ triggerLabel: "maestro", ...row } as BindingRow),
    }).resolve("OPS");

    expect(binding).toEqual({
      projectKey: "OPS",
      active: true, // state "active" → live
      triggerMode: "opt_in", // trigger "label" → opt_in
      appId: "Uguryldz/maestro-pilot",
      mode: "human_lead",
      dataClass: "gizli",
    });
  });

  it("upserts: re-binding a project overwrites rather than duplicating", async () => {
    const { writer, rows } = writerOf();
    await writer.bind({
      projectKey: "OPS",
      trigger: "auto",
      state: "active",
      defaults: { appId: "a/one", mode: "full_auto", dataClass: "acik" },
    });
    await writer.bind({
      projectKey: "OPS",
      trigger: "label",
      state: "paused",
      defaults: { appId: "a/two", mode: "human_only", dataClass: "gizli" },
    });

    expect(rows.size).toBe(1);
    expect(rows.get("OPS")).toMatchObject({ trigger: "label", state: "paused" });
  });
});
