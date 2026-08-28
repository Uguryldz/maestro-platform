/**
 * TEK SEFERLİK: admin DIŞINDAKİ tüm demo/test kullanıcılarını siler.
 *
 * Kullanıcı isteği (sıfır-prod): "users listesi neden temiz değil" → admin
 * dışında hiç kullanıcı kalmasın; gerçek ekip Studio'dan eklenir.
 *
 * KORUNAN: admin grubundaki (`maestro-admins`) HER kullanıcı — id sabitine
 * GÜVENME (admin'in id'si "admin" değil "admin@maestro.local"; id sabiti
 * kullanmak yanlışlıkla admin'i siler). Silinen kullanıcıların oturumları da
 * temizlenir (yetim session bırakma).
 *
 * User/Session append-only DEĞİL → normal deleteMany güvenli.
 */
import { createDb, FIRST_ADMIN_GROUP } from "@maestro/db";
import { isEntrypoint } from "./lifecycle.js";

/** Bu gruplardan BİRİNE üye olan kullanıcı KORUNUR (silinmez). */
const KEEP_IF_IN_GROUPS = [FIRST_ADMIN_GROUP] as const;

function isProtected(groupsJson: unknown): boolean {
  const groups = Array.isArray(groupsJson) ? (groupsJson as string[]) : [];
  return groups.some((g) => KEEP_IF_IN_GROUPS.includes(g as (typeof KEEP_IF_IN_GROUPS)[number]));
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL yok");
  const db = createDb(url) as unknown as {
    user: {
      findMany: (a: unknown) => Promise<Array<{ id: string; email: string; groupsJson: unknown }>>;
      deleteMany: (a: unknown) => Promise<{ count: number }>;
    };
    session: { deleteMany: (a: unknown) => Promise<{ count: number }> };
    $disconnect: () => Promise<void>;
  };

  const before = await db.user.findMany({ select: { id: true, email: true, groupsJson: true } });
  const toDelete = before.filter((u) => !isProtected(u.groupsJson));
  const deleteIds = toDelete.map((u) => u.id);

  // Güvenlik ağı: en az bir admin KALMALI, yoksa hiç silme.
  const survivingAdmins = before.filter((u) => isProtected(u.groupsJson));
  if (survivingAdmins.length === 0) {
    console.error("✗ İPTAL: hiç admin bulunamadı — silsem kimse giremez. Önce bir admin olmalı.");
    await db.$disconnect();
    process.exit(1);
  }

  console.log(`── Kullanıcılar (önce ${before.length}) ──`);
  for (const u of before) {
    console.log(`  ${isProtected(u.groupsJson) ? "KORU" : "SİL "}  ${u.id.padEnd(20)} ${u.email}`);
  }

  if (deleteIds.length === 0) {
    console.log("\nSilinecek kullanıcı yok.");
    await db.$disconnect();
    return;
  }

  console.log("\n→ Siliniyor…");
  // Önce silinen kullanıcıların oturumları (yetim session kalmasın).
  const sess = await db.session.deleteMany({ where: { userId: { in: deleteIds } } });
  if (sess.count > 0) console.log(`  ✓ session: ${sess.count} silindi (silinen kullanıcılara ait)`);
  const del = await db.user.deleteMany({ where: { id: { in: deleteIds } } });
  console.log(`  ✓ user: ${del.count} silindi`);

  const after = await db.user.findMany({ select: { id: true, email: true, groupsJson: true } });
  console.log(`\n── Kullanıcılar (sonra ${after.length}) ──`);
  for (const u of after) console.log(`  ${u.id.padEnd(20)} ${u.email}`);

  await db.$disconnect();

  const leftoverDemo = after.filter((u) => !isProtected(u.groupsJson));
  if (leftoverDemo.length > 0) {
    console.error(`\n✗ Hâlâ demo kullanıcı var: ${leftoverDemo.map((u) => u.id).join(", ")}`);
    process.exit(1);
  }
  if (!after.some((u) => isProtected(u.groupsJson))) {
    console.error("\n✗ KRİTİK: hiç admin kalmamış!");
    process.exit(1);
  }
  console.log("\n✅ Sadece admin(ler) kaldı. Gerçek ekibi Kullanıcılar & roller ekranından ekleyebilirsin.");
}

if (isEntrypoint(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
