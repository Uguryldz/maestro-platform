import { FOUR_EYES_GROUP } from "./propose.js";

/**
 * Master-admin self-approval exemption (kullanıcı isteği: "tek master admin
 * benim, master admin 2. onayı da verebilir").
 *
 * Dört-göz / SoD kuralı KURUMSAL olarak korunur: normal roller (tech-lead,
 * product-owner…) HÂLÂ kendi önerilerini onaylayamaz. Yalnızca
 * `FOUR_EYES_GROUP` (maestro-admins) üyesi bir master admin, kendi önerdiği
 * paketi/parametreyi/gate'i tek başına onaylayabilir — bu, tek yöneticili bir
 * kurulumun kilitlenmesini önler ve denetim izine "tek kişi onayı (master
 * admin)" olarak açıkça yazılır (çağıran taraf audit meta'ya `soloApproval`
 * ekler).
 *
 * Bu, sistemdeki TEK self-approval istisnasıdır. Kimlik değil GRUP üyeliğiyle
 * karar verilir (master admin'in id'si `admin@maestro.local`; kimlik sabitine
 * güvenmek kırılgan — grup üyeliği doğru ölçüttür).
 */
export function isMasterApprover(groups: readonly string[]): boolean {
  return groups.includes(FOUR_EYES_GROUP);
}
