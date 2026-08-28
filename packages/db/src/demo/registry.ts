import type { Prisma } from "@prisma/client";
import { ago } from "./clock.js";

/** Application registry + repo cards (M100) — the mock's five applications. */

export const APPLICATIONS: Prisma.ApplicationCreateManyInput[] = [
  {
    appId: "ugurpay",
    displayName: "ugurpay",
    adoProject: "Odeme",
    adoRepo: "ugurpay",
    platform: "linux-node",
    jiraComponent: "pay-web/api",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurweb",
    displayName: "ugurweb",
    adoProject: "Web",
    adoRepo: "ugurweb",
    platform: "linux-node",
    jiraComponent: "web",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmobil-ios",
    displayName: "ugurmobil-ios",
    adoProject: "Mobil",
    adoRepo: "ugurmobil-ios",
    platform: "macos-xcode",
    jiraComponent: "ios",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmobil-android",
    displayName: "ugurmobil-android",
    adoProject: "Mobil",
    adoRepo: "ugurmobil-android",
    platform: "linux-android",
    jiraComponent: "android",
    maestroYamlPresent: true,
    createdVia: "import",
  },
  {
    appId: "ugurmasaustu",
    displayName: "ugurmasaüstü",
    adoProject: "Sube",
    adoRepo: "ugurmasaustu",
    platform: "windows-dotnet",
    jiraComponent: "sube-masaustu",
    maestroYamlPresent: false, // onboarding will propose the file by PR (M93)
    createdVia: "onboarding",
  },
];

const REPO_CARD_MODULES: Record<string, { name: string; path: string; summary: string }[]> = {
  ugurpay: [
    { name: "payments-api", path: "apps/api/payments", summary: "Payment, refund and limit endpoints" },
    { name: "limits", path: "packages/limits", summary: "Credit limit rules and validation" },
    { name: "web", path: "apps/web", summary: "Customer-facing Next.js screens" },
  ],
  ugurweb: [
    { name: "components", path: "src/components", summary: "Shared React component library" },
    { name: "pages", path: "src/pages", summary: "Public marketing and login pages" },
  ],
  "ugurmobil-ios": [
    { name: "Auth", path: "Sources/Auth", summary: "Login, Face ID and certificate pinning" },
    { name: "Payments", path: "Sources/Payments", summary: "Transfer and limit screens" },
  ],
  "ugurmobil-android": [
    { name: "auth", path: "app/src/main/auth", summary: "Login and biometric flows" },
    { name: "notifications", path: "app/src/main/notifications", summary: "Push permissions and channels" },
  ],
  ugurmasaustu: [
    { name: "Reporting", path: "src/Reporting", summary: "Branch reporting and export" },
    { name: "Eft", path: "src/Eft", summary: "Bulk EFT file import" },
  ],
};

export const REPO_CARDS: Prisma.RepoCardCreateManyInput[] = Object.entries(REPO_CARD_MODULES).map(
  ([appId, modules], index) => ({
    appId,
    version: 1,
    modulesJson: modules,
    generatedFromSha: `a1b2c3d4e5f60718293a4b5c6d7e8f90${index}0000000`.slice(0, 40),
    updatedAt: ago(24 * (index + 2)),
  }),
);

/**
 * Knowledge base (M83): documents are keyed by `(id, version)`, so a flow that
 * pinned `analiz-sablonu` v2 can still read it after v3 lands. The demo carries
 * the tail of each document's history for the two that were revised.
 */
export const KNOWLEDGE_DOCS: Prisma.KnowledgeDocCreateManyInput[] = [
  { id: "analiz-sablonu", kind: "template", title: "analiz-sablonu.md", version: 2, contentRef: "knowledge/rules/analiz-sablonu.v2.md", updatedAt: ago(24 * 40) },
  { id: "analiz-sablonu", kind: "template", title: "analiz-sablonu.md", version: 3, contentRef: "knowledge/rules/analiz-sablonu.v3.md", updatedAt: ago(240) },
  { id: "bddk-uyum", kind: "policy", title: "bddk-uyum.md", version: 2, contentRef: "knowledge/rules/bddk-uyum.v2.md", updatedAt: ago(24 * 30) },
  { id: "api-tasarim", kind: "standard", title: "api-tasarim.md", version: 4, contentRef: "knowledge/conventions/api-tasarim.v4.md", updatedAt: ago(24 * 45) },
  { id: "api-tasarim", kind: "standard", title: "api-tasarim.md", version: 5, contentRef: "knowledge/conventions/api-tasarim.v5.md", updatedAt: ago(24 * 8) },
  { id: "kredi-urunleri", kind: "app_intro", title: "kredi-urunleri.md", version: 4, contentRef: "knowledge/domain/kredi-urunleri.v4.md", updatedAt: ago(24 * 14) },
  { id: "erisilebilirlik", kind: "standard", title: "erisilebilirlik.md", version: 1, contentRef: "knowledge/rules/erisilebilirlik.v1.md", updatedAt: ago(24 * 60) },
  { id: "test-piramidi", kind: "standard", title: "test-piramidi.md", version: 3, contentRef: "knowledge/conventions/test-piramidi.v3.md", updatedAt: ago(24 * 21) },
];

/**
 * Local MVP users (M8). `passwordHash` is a deliberately unmatchable
 * placeholder: the demo must never ship a working default credential. An admin
 * sets the first password out of band; AD/LDAP replaces all of this in Aşama 2.
 */
export const NO_PASSWORD_SET = "!";

export const USERS: Prisma.UserCreateManyInput[] = [
  { id: "u-ugur", email: "ugur.yildiz@ugurbank.local", displayName: "Uğur Yıldız", passwordHash: NO_PASSWORD_SET, groupsJson: ["maestro-admins"], active: true },
  { id: "u-ayse", email: "ayse.kaya@ugurbank.local", displayName: "Ayşe Kaya", passwordHash: NO_PASSWORD_SET, groupsJson: ["product-owners", "tech-leads"], active: true },
  { id: "u-mert", email: "mert.demir@ugurbank.local", displayName: "Mert Demir", passwordHash: NO_PASSWORD_SET, groupsJson: ["tech-leads"], active: true },
  { id: "u-deniz", email: "deniz.yalcin@ugurbank.local", displayName: "Deniz Yalçın", passwordHash: NO_PASSWORD_SET, groupsJson: ["qa"], active: true },
  { id: "u-baran", email: "baran.tunc@ugurbank.local", displayName: "Baran Tunç", passwordHash: NO_PASSWORD_SET, groupsJson: ["developers"], active: true },
  { id: "u-can", email: "can.ozturk@ugurbank.local", displayName: "Can Öztürk", passwordHash: NO_PASSWORD_SET, groupsJson: ["product-owners"], active: true },
  { id: "u-denetim", email: "denetim@ugurbank.local", displayName: "Denetim (salt-okunur)", passwordHash: NO_PASSWORD_SET, groupsJson: ["internal-audit"], active: true },
];
