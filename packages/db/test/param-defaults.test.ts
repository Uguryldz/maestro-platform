import { describe, expect, it } from "vitest";
import {
  GATES_BY_RISK,
  Locale,
  NotifyChannel,
  NotifyEventKey,
  PlatformProfile,
  ScanSeverity,
  TriggerMode,
} from "@maestro/contracts";
import { DEFAULT_PARAM_DEFINITIONS } from "../src/index.js";

/** Seeded values are decisions from the master plan — pinned one by one. */
describe("seeded defaults follow the decision record", () => {
  function def(key: string) {
    const found = DEFAULT_PARAM_DEFINITIONS.find((d) => d.key === key);
    expect(found, `missing seed parameter ${key}`).toBeDefined();
    return found!;
  }

  it("M51 gate sets equal the contract's GATES_BY_RISK", () => {
    expect(def("gates.risk_tiers").defaultValue).toEqual({
      dusuk: [...GATES_BY_RISK.dusuk],
      orta: [...GATES_BY_RISK.orta],
      kritik: [...GATES_BY_RISK.kritik],
    });
  });

  it("M102 trigger mode offers the contract's modes and opts in by label", () => {
    expect(def("trigger.mode").enumValues).toEqual([...TriggerMode.options]);
    expect(def("trigger.mode").defaultValue).toBe("label");
  });

  it("M88 escalation ladder is 24h -> 72h -> 7d, ending in a delegation", () => {
    const ladder = def("escalation.ladder").defaultValue as {
      steps: { id: string; afterHours: number; action?: string; messageKey?: string }[];
    };
    expect(ladder.steps.map((s) => s.afterHours)).toEqual([24, 72, 168]);
    expect(ladder.steps.map((s) => s.id)).toEqual(["reminder-24h", "escalation-72h", "delegate-7d"]);
    expect(ladder.steps.at(-1)).toMatchObject({ action: "delegate", messageKey: "notify.delegated" });
  });

  it("M45/M87 notification routing is a parameter, keyed by NotifyEventKey", () => {
    const routing = def("notify.routing").defaultValue as {
      default: string[];
      byEvent: Record<string, string[]>;
    };
    const events = new Set<string>(NotifyEventKey.options);
    const channels = new Set<string>(NotifyChannel.options);
    expect(routing.default.every((channel) => channels.has(channel))).toBe(true);
    for (const [event, targets] of Object.entries(routing.byEvent)) {
      expect(events.has(event), event).toBe(true);
      expect(targets.every((channel) => channels.has(channel)), event).toBe(true);
    }
    // M87: runner health warnings have an explicit ops channel.
    expect(routing.byEvent["runner_health"]).toBeDefined();
  });

  it("M59 output language offers the supported locales and defaults to tr", () => {
    const language = def("lang.output");
    expect(language.enumValues).toEqual([...Locale.options]);
    expect(language.defaultValue).toBe("tr");
  });

  it("M70 coverage ratchet forbids decreases and floors new lines at 80%", () => {
    expect(def("coverage.ratchet").defaultValue).toEqual({
      allowDecrease: false,
      minNewLinePct: 80,
    });
  });

  it("M92 QA separation of duties ships OFF", () => {
    expect(def("sod.qa_split").defaultValue).toBe(false);
  });

  it("M65 workspace archive age is 60 days", () => {
    expect(def("workspace.max_age_days").defaultValue).toBe(60);
  });

  it("M54 stuck protection hands over after 3 rejections or 3 CI failures", () => {
    expect(def("stuck.threshold").defaultValue).toEqual({
      gateRejections: 3,
      ciFailures: 3,
      action: "handover_ai_assist",
    });
  });

  it("M19 quota warning fires at 80% of a window", () => {
    expect(def("quota.warn_pct").defaultValue).toBe(80);
  });

  it("M85 build timeouts are per platform profile, with one auto re-queue", () => {
    const timeouts = def("build.timeout_min").defaultValue as {
      byPlatform: Record<string, number>;
      autoRequeueCount: number;
    };
    expect(Object.keys(timeouts.byPlatform).sort()).toEqual([...PlatformProfile.options].sort());
    expect(timeouts.byPlatform["linux-node"]).toBe(30);
    expect(timeouts.byPlatform["windows-dotnet"]).toBe(45);
    expect(timeouts.byPlatform["macos-xcode"]).toBe(60);
    expect(timeouts.autoRequeueCount).toBe(1);
  });

  it("M27 scan block level uses ScanSeverity and blocks from high upwards", () => {
    expect(def("scan.block_level").enumValues).toEqual([...ScanSeverity.options]);
    expect(def("scan.block_level").defaultValue).toBe("high");
  });

  it("M58 kill switch has both levels plus off, and starts off", () => {
    const killSwitch = def("killswitch.state");
    expect(killSwitch.enumValues).toEqual(["off", "intake_only", "all"]);
    expect(killSwitch.defaultValue).toBe("off");
  });

  it("M48 merge mode defaults to human merge", () => {
    expect(def("merge.mode").defaultValue).toBe("human_merge");
    expect(def("merge.mode").scope).toBe("project");
  });

  it("M102 dry-run sample size is 20", () => {
    expect(def("binding.dry_run_sample_size").defaultValue).toBe(20);
  });

  it("M18 data-class policy degrades to ai-assist when on-prem is missing", () => {
    expect(def("dataclass.policy").defaultValue).toEqual({
      backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
      whenOnpremMissing: "degrade_ai_assist",
    });
  });

  it("M55 subscription queueing is on (exhausted pool waits, never fails)", () => {
    expect(def("subscription.queue_enabled").defaultValue).toBe(true);
  });

  it("M45 reminder channel is a NotifyPort channel, defaulting to Jira", () => {
    const channel = def("notify.reminder_channel");
    expect(channel.enumValues).toEqual([...NotifyChannel.options]);
    expect(channel.defaultValue).toBe("jira");
  });
});

