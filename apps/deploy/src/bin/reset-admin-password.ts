/**
 * Operator password reset — the container half of `deploy/<paket>/reset-admin.sh`.
 *
 * Usage (inside the node image, which is how the script runs it):
 *   node apps/deploy/dist/bin/reset-admin-password.js [kullanıcı-adı]
 *
 * The account gets a fresh RANDOM password (never a well-known one — the old
 * version of this bin hard-reset `admin` to `admin123` and switched the forced
 * change OFF, which is exactly the pair of decisions a production system must
 * not offer as a one-liner). The new password is printed ONCE, the account is
 * forced through the change-password screen on its next login, and every live
 * session of the account is destroyed.
 *
 * All operator-facing output is Turkish — this bin's stdout IS the UI of
 * `reset-admin.sh`. Logic lives in ../reset-admin.ts, which is unit-tested;
 * this file only wires the real database and hasher to it and formats the
 * result.
 */
import { createDb } from "@maestro/db";
import { BcryptPasswordHasher } from "@maestro/bff";
import { resetAccountPassword, type ResetDb } from "../reset-admin.js";
import { isEntrypoint } from "./lifecycle.js";

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("✘ DATABASE_URL tanımlı değil — bu komut konteyner içinde çalışmalıdır (./reset-admin.sh).");
    process.exit(1);
  }

  const username = (argv[2] ?? "admin").trim();
  if (username === "" || username.startsWith("-")) {
    console.error(`✘ Geçersiz kullanıcı adı: '${argv[2] ?? ""}'. Kullanım: ./reset-admin.sh <kullanıcı-adı>`);
    process.exit(1);
  }

  const db = createDb(url) as unknown as ResetDb & { $disconnect(): Promise<void> };
  try {
    // The same cost the BFF uses for its own hashes; `verify` below proves the
    // round trip with the same implementation the login path runs.
    const hasher = new BcryptPasswordHasher();
    const result = await resetAccountPassword(db, (password) => hasher.hash(password), username);

    if (!result.ok) {
      console.error(`✘ '${username}' adında bir hesap yok (kullanıcı adı = giriş ekranındaki ad).`);
      console.error("  Mevcut hesapları panelin Kullanıcılar ekranından görebilirsiniz.");
      process.exit(2);
    }

    // Belt and braces: read the row back and verify the fresh hash actually
    // opens with the password about to be handed to the operator. A reset that
    // prints a password the login path then refuses is worse than no reset.
    const stored = await db.user.findUnique({ where: { email: result.username } });
    const verified = stored !== null && (await hasher.verify(result.password, stored.passwordHash));
    if (!verified) {
      console.error("✘ Reset yazıldı ama doğrulama BAŞARISIZ — veritabanı loglarını inceleyin, parola dağıtılmadı.");
      process.exit(1);
    }

    console.log(`✔ Parola sıfırlandı: ${result.username}`);
    console.log("");
    console.log(`  YENİ GEÇİCİ PAROLA (yalnızca şimdi gösterilir): ${result.password}`);
    console.log("");
    console.log("  İlk girişte sistem yeni bir parola belirlemeyi ZORUNLU tutar.");
    if (result.reactivated) {
      console.log("  Not: hesap pasifti, yeniden AKTİF edildi.");
    }
    console.log(
      result.killedSessions > 0
        ? `  Hesabın açık oturumları kapatıldı: ${String(result.killedSessions)}`
        : "  Açık oturum yoktu.",
    );
  } finally {
    await db.$disconnect();
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`✘ Parola sıfırlama başarısız: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
