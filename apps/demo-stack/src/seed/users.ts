/**
 * The demo roster (M8/M86).
 *
 * Every role in `ROLES` has at least one holder, plus an auditor for the trail
 * screen, so a reviewer can log in as each and watch the SAME server refuse
 * different things. `seed.test.ts` asserts the coverage, so a role added to
 * contracts breaks this file rather than quietly losing its demo account.
 *
 * The passwords are in the clear on purpose — they are the `deploy/.env.example`
 * pattern: a local-only development credential is not a secret, and a demo whose
 * logins are undiscoverable is a demo nobody can run. They still go through
 * bcrypt and the real password policy (12 chars, upper/lower/digit/symbol, not
 * containing the username), because the login path is not being faked. Nothing
 * here may ever be reused outside the demo stack.
 */
export interface DemoAccount {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  /**
   * Typed as plain strings, matching `UserRecord.roles`, because the BFF's
   * authorisation vocabulary is WIDER than contracts' `Role` enum: `AUDIT_ROLES`
   * and `CONFIDENTIAL_ROLES` both accept `internal-audit`, which the enum does
   * not contain. Narrowing to `Role` here would make the audit account
   * unrepresentable — see the ARAYÜZ İSTEĞİ note in README.md. `seed.test.ts`
   * still asserts every contract `Role` is held by somebody.
   */
  readonly roles: readonly string[];
  /**
   * Directory groups, verbatim. Project access follows the `maestro-<project>`
   * convention (`routes/access.ts`), gate ownership follows the gate directory,
   * and `maestro-gizli` is the clearance for confidential knowledge.
   */
  readonly groups: readonly string[];
  /** What this account is for, so a reviewer knows which one to log in as. */
  readonly demonstrates: string;
}

/** The corporate suffix the audit actor is built from (`user@corp`, M33). */
export const DEMO_ACTOR_DOMAIN = "ugurbank.local";

export function actorOf(username: string): string {
  return `${username}@${DEMO_ACTOR_DOMAIN}`;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    username: "ayse.kaya",
    displayName: "Ayşe Kaya",
    password: "Demo!Maestro-2026",
    roles: ["admin"],
    groups: ["maestro-platform", "maestro-gizli"],
    demonstrates:
      "Platform yöneticisi: runner/kota/sağlık ekranları, kill switch, gizli bilgi tabanı kayıtları.",
  },
  {
    username: "mert.demir",
    displayName: "Mert Demir",
    password: "Demo!Maestro-2026",
    roles: ["tech-lead"],
    groups: ["maestro-tech-leads", "maestro-ugurpay", "maestro-ugurweb"],
    demonstrates:
      "Tech Lead: 5 ve 12 numaralı kapıların sahibi — UGURPAY-501'in PR onayını gerçekten kapatabilir.",
  },
  {
    username: "can.ozturk",
    displayName: "Can Öztürk",
    password: "Demo!Maestro-2026",
    roles: ["product-owner"],
    groups: ["maestro-product-owners", "maestro-ugurpay"],
    demonstrates:
      "Product Owner: 4 numaralı analiz kapısının sahibi — UGURPAY-504'ü onaylayabilir, PR kapısını onaylayamaz.",
  },
  {
    username: "deniz.yilmaz",
    displayName: "Deniz Yılmaz",
    password: "Demo!Maestro-2026",
    roles: ["qa"],
    groups: ["maestro-qa", "maestro-ugurpay", "maestro-ugurweb"],
    demonstrates:
      "QA: 9 ve 11 numaralı test kapılarının sahibi — UGURPAY-123'ün sonuç onayını kapatabilir.",
  },
  {
    username: "baran.tekin",
    displayName: "Baran Tekin",
    password: "Demo!Maestro-2026",
    roles: ["developer"],
    groups: ["maestro-ugurdesk", "maestro-ugurmob"],
    demonstrates:
      "Geliştirici: yalnız kendi projelerini görür — UGURPAY biletlerine 403 alır, runner ekranına da.",
  },
  {
    username: "selin.aydin",
    displayName: "Selin Aydın",
    password: "Demo!Maestro-2026",
    roles: ["viewer"],
    groups: ["maestro-ugurmob"],
    demonstrates:
      "Salt okuyucu: hiçbir yönetim ucuna erişemez (403), kapı kararı veremez, gizli kayıt göremez.",
  },
  {
    // `internal-audit` is the role the BFF's `AUDIT_ROLES` accepts and the
    // contract enum does not; without this account the trail screen has no
    // reader other than `admin`.
    username: "hulya.arslan",
    displayName: "Hülya Arslan",
    password: "Demo!Maestro-2026",
    roles: ["internal-audit"],
    groups: ["maestro-audit", "maestro-gizli"],
    demonstrates:
      "İç denetim: denetim zinciri ve doğrulaması yalnız bu rolle (ve admin ile) okunabilir (M33).",
  },
];

/** One shared password for every demo account; printed at boot and in the README. */
export const DEMO_PASSWORD = "Demo!Maestro-2026";
