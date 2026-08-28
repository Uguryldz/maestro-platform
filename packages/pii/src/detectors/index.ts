import { DETECTOR_TYPES, type Detector, type DetectorType } from "../types.js";
import { accountDetector } from "./account.js";
import { cardDetector } from "./card.js";
import { emailDetector } from "./email.js";
import { ibanDetector } from "./iban.js";
import { phoneDetector } from "./phone.js";
import { tcknDetector } from "./tckn.js";

/** Registry: exactly one detector per declared type — checked by a test. */
export const DETECTORS: Readonly<Record<DetectorType, Detector>> = {
  iban: ibanDetector,
  card: cardDetector,
  tckn: tcknDetector,
  phone: phoneDetector,
  email: emailDetector,
  account: accountDetector,
};

/** Lower number wins an equal-length overlap; see DETECTOR_TYPES. */
export function detectorPriority(type: DetectorType): number {
  return DETECTOR_TYPES.indexOf(type);
}

export { accountDetector, cardDetector, emailDetector, ibanDetector, phoneDetector, tcknDetector };
export { compileAccountPatterns } from "./account.js";
export { isValidTckn } from "./tckn.js";
export { canonicalIban, isValidIban } from "./iban.js";
export { isValidLuhn } from "./card.js";
export { canonicalPhone } from "./phone.js";
