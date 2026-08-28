import { compiledProfileFor, defaultPiiPolicy, scanForPii } from "@maestro/pii";
import { describe, expect, it } from "vitest";

/**
 * B10 — ticket-level PII gate. The pilot's `escalateDataClassForPii` scans a
 * ticket's own text (summary + description + text attachments) with the WIDEST
 * profile ("acik" masks the most) and raises the run's data class to "gizli"
 * the moment it finds anything. These tests pin the DECISION the pilot makes
 * from `scanForPii` — that a TCKN/IBAN pasted into a ticket trips the gate and
 * that clean, ordinary ticket text does not — so the escalation can never
 * silently stop detecting.
 *
 * The values below are SYNTHETIC (checksum-valid, but not real): built the same
 * way packages/pii/test/synthetic.ts builds its fixtures. No real identifier
 * appears here.
 */

const SYNTHETIC_TCKN = "12345678950"; // makeTckn("123456789")
const SYNTHETIC_IBAN = "TR180006200119000006672315"; // makeIban("TR", "0006200119000006672315")

// Mirrors run.ts escalateDataClassForPii: widest profile, one occurrence trips.
function ticketTripsPiiGate(haystack: {
  summary: string;
  description: string;
  attachments: string[];
}): boolean {
  const widest = compiledProfileFor(defaultPiiPolicy(), "acik").profile;
  return scanForPii(haystack, widest).occurrences > 0;
}

describe("B10 ticket-level PII gate decision", () => {
  it("trips on a TCKN in the ticket description", () => {
    expect(
      ticketTripsPiiGate({
        summary: "Müşteri ekranında hata",
        description: `Müşteri TCKN ${SYNTHETIC_TCKN} ile giriş yapamıyor.`,
        attachments: [],
      }),
    ).toBe(true);
  });

  it("trips on an IBAN in the ticket description", () => {
    expect(
      ticketTripsPiiGate({
        summary: "Havale başarısız",
        description: `Alıcı IBAN ${SYNTHETIC_IBAN} için transfer düşmüyor.`,
        attachments: [],
      }),
    ).toBe(true);
  });

  it("trips on PII carried only in a text attachment", () => {
    expect(
      ticketTripsPiiGate({
        summary: "Log ekli",
        description: "Detaylar ekteki log dosyasında.",
        attachments: [`user tckn=${SYNTHETIC_TCKN} login failed`],
      }),
    ).toBe(true);
  });

  it("does NOT trip on clean, ordinary ticket text", () => {
    expect(
      ticketTripsPiiGate({
        summary: "Ödeme ekranında buton hizası bozuk",
        description:
          "UGURPAY-123 ekranında Öde butonu mobilde taşıyor. Sipariş no 12345678901 örnek olarak paylaşıldı ama kişisel veri yok.",
        attachments: ["stack trace: NullPointerException at PaymentController.java:42"],
      }),
    ).toBe(false);
  });
});
