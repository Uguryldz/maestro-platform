/**
 * Public surface of `@maestro/pilot` for a LAUNCHER that boots it.
 *
 * `main.ts` is the standalone, DB-free entry (env fallback). A launcher that
 * CAN read Postgres — the composition root in `apps/deploy` — imports `bootPilot`
 * from here and hands it a `VariantModelReader` so the model is resolved from the
 * variant (Studio/DB), not env. Only the port TYPE crosses this boundary: the
 * pilot stays DB-free; the reader implementation lives in the launcher.
 */
export { bootPilot } from "./boot.js";
export type { BootOptions, PilotStage } from "./boot.js";
export type { VariantModelReader, ResolvedVariantModel } from "./variant.js";
export type { ListeningRule, FlowType } from "./listening.js";
// The launcher persists these: the UI-edited settings (seed + change hook) and
// the corporate Word template loader's shape.
export type { PilotSettings } from "./settings.js";
export type { PilotDocTemplate } from "./docs.js";
// The Studio analysis-template overlay: the launcher wires a lazy loader that
// reads the ACTIVE `AnalysisTemplateVersion`; the pilot applies only title +
// aiInstruction onto the engine template (safe overlay — bindings frozen).
export type {
  AnalysisTemplateOverlay,
  AnalysisTemplateOverlaySection,
  AnalysisTemplateOverlayLoader,
} from "./analysis.js";

// The canonical nine step definitions live in the side-effect-free `./state`
// subpath (see package.json exports) so a consumer — Studio's agent-pipeline map
// — can prove its step ids line up with the pilot's without pulling in the
// barrel's boot/server. Re-exported here too for launchers already on the barrel.
export { STEP_DEFINITIONS } from "./state.js";
export type { PilotStep, StepState } from "./state.js";
