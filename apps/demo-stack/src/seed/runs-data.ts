import type { DemoRun } from "./runs.js";
import { OTHER_RUNS } from "./runs-other.js";
import { UGURPAY_RUNS } from "./runs-ugurpay.js";

/**
 * The seeded delivery board, faithful to `mock/index.html`: a bank's payment,
 * web, mobile and desktop teams, one fan-out parent with four children, runs
 * waiting at every kind of gate, two failures and two closed tickets.
 *
 * Split across two files by domain purely for size. Every field is a fact the
 * screens actually render. The one thing NOT encoded is progress: nothing in
 * the demo advances a run on its own, so a status only changes when somebody
 * makes it change — which is what makes an approved gate visible as a real
 * state transition rather than a repaint.
 */
export const DEMO_RUNS: readonly DemoRun[] = [...UGURPAY_RUNS, ...OTHER_RUNS];
