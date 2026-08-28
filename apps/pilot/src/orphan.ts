import type { TicketKey } from "@maestro/contracts";
import { DISCOVERY_MAX, PROJECT_KEY } from "./config.js";
import type { LogLevel } from "./state.js";

/**
 * YETİM İŞ GÖRÜNÜRLÜĞÜ (v1) — "hiç kapanmayan worker" paketinin gözü.
 *
 * Motor yeniden başladığında, ONAY KAPISINDA bekleyen bir iş yetim kalır: run
 * belleği gitmiştir, ticket ise hâlâ İNCELEMEDE'de Analist Yönetici'nin
 * üzerindedir ve kimse ona dönmez. v1'in amacı akış-içi devam DEĞİL — devralma,
 * kullanıcı ticket'ı tekrar Maestro Bot'a atayınca mevcut atama-keşif +
 * oto-başlatma zinciriyle zaten olur. Buradaki tek amaç SESSİZ KAYIP OLMASIN:
 * boot'ta bir kez, kapıda bekliyor görünen ticket'ları bul, pilot günlüğüne
 * yaz ve ticket'a BİR KEZ kısa bir yönlendirme yorumu bırak.
 *
 * FAIL-SOFT sözleşmesi: bu tarama hiçbir koşulda boot'u bozamaz. Arama hatası,
 * yorum hatası, tuhaf yanıt şekli — hepsi yutulur ve en fazla bir warn satırı
 * olur. `detectOrphans` asla reddedilmez (never rejects).
 */

/**
 * ÇİFT-YORUM işareti: yorumlarda bu metin zaten geçiyorsa ticket'a yeniden
 * yorum yazılmaz — her restart aynı yetime yeni bir yorum eklemesin.
 */
export const ORPHAN_MARKER = "⟲ motor yeniden başladı";

/** The one comment an orphan gets — kısa, Türkçe ve işareti içinde taşır. */
export function orphanCommentText(): string {
  return (
    `${ORPHAN_MARKER} — bu iş onay kapısında bekliyordu ve motor yeniden başlatıldı. ` +
    "Devam etmek için ticket'ı Maestro Bot'a atayın; analiz zaten ticket'te."
  );
}

/**
 * Kapıda bekleyen yetimlerin JQL'i. Keşif JQL'iyle aynı desen (bounded: proje
 * adlandırılır, opak accountId tırnaklanır), ama tersten bakar: onay devri
 * ticket'ı YÖNETİCİ'ye atar ve İNCELEMEDE'ye taşır — restart sonrası bu
 * durumda ve `maestro` etiketli duran her ticket kapıda bekliyordu demektir
 * (etiketi akışın kendisi basar, bkz. run.ts "etiketler güncellendi").
 */
export function orphanJql(
  managerAccountId: string,
  reviewStatusName: string,
  projectKey: string = PROJECT_KEY,
): string {
  const status = reviewStatusName.trim();
  const assignee = `"${managerAccountId.trim()}"`;
  return (
    `project = ${projectKey} AND labels = maestro AND status = "${status}" ` +
    `AND assignee = ${assignee} ORDER BY created DESC`
  );
}

/**
 * Daraltılmış iş portu: taramanın kullandığı üç yetenek. `JiraCloudWorkPort`
 * bunu yapısal olarak karşılar; testler ağ olmadan sahte bir nesne geçirir.
 */
export interface OrphanWork {
  searchIssues(request: {
    jql: string;
    maxResults?: number;
    fields?: string[];
  }): Promise<{ issues: unknown[] }>;
  listComments(key: TicketKey): Promise<unknown[]>;
  addComment(key: TicketKey, body: unknown): Promise<{ commentId: string }>;
}

export interface DetectOrphansOptions {
  work: OrphanWork;
  /** Analist Yönetici'nin accountId'si (deps.managerAccountId). Boşsa tarama atlanır. */
  managerAccountId: string;
  /** Onay devrinin taşıdığı inceleme statüsü (ayarlardaki reviewStatusName). */
  reviewStatusName: string;
  projectKey?: string;
  log: (level: LogLevel, text: string) => void;
}

export interface OrphanReport {
  /** Kapıda bekliyor bulunan ticket anahtarları. */
  found: string[];
  /** Bu turda yorum yazılanlar. */
  commented: string[];
  /** İşaret zaten vardı — yorum atlananlar. */
  skippedExisting: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Bir yorumun gövdesinde işaret metni geçiyor mu? Cloud yorumu ADF taşır ve
 * şekli sürüme göre oynar; metin düğümlerini tek tek gezmek yerine ham yorumu
 * serileştirip işareti aramak hem şekil-bağımsız hem fail-soft'tur (işaret
 * metni opak bir damga — başka bir bağlamda geçmesi beklenmez).
 */
export function commentCarriesMarker(comment: unknown): boolean {
  try {
    return JSON.stringify(comment)?.includes(ORPHAN_MARKER) === true;
  } catch {
    return false; // serileştirilemeyen yorum işareti taşıyamaz — yeniden yazmak zararsız
  }
}

/**
 * Boot'ta BİR KEZ çalışan tarama. Bulunan her yetim için: (a) pilot günlüğüne
 * warn satırı, (b) işaret yoksa ticket'a tek yönlendirme yorumu. Asla throw
 * etmez — dönen rapor test içindir, çağıran (boot) sonucu beklemek zorunda
 * değildir.
 */
export async function detectOrphans(options: DetectOrphansOptions): Promise<OrphanReport> {
  const report: OrphanReport = { found: [], commented: [], skippedExisting: [] };
  const managerAccountId = options.managerAccountId.trim();
  if (managerAccountId === "") {
    // Yönetici kimliği yoksa onay devri zaten reassign yapmaz — kapıda bekleyen
    // iş botun üzerinde kalır ve normal keşif onu görür; taranacak yetim yok.
    options.log("dim", "→ yetim iş taraması atlandı: MAESTRO_MANAGER_ACCOUNT_ID tanımlı değil");
    return report;
  }

  const jql = orphanJql(managerAccountId, options.reviewStatusName, options.projectKey);
  let issues: unknown[];
  try {
    const page = await options.work.searchIssues({
      jql,
      maxResults: DISCOVERY_MAX,
      fields: ["summary", "status"],
    });
    issues = page.issues;
  } catch (error) {
    options.log("warn", `! yetim iş taraması başarısız (boot etkilenmedi): ${String(error)}`);
    return report;
  }

  for (const raw of issues) {
    const key = record(raw)?.["key"];
    if (typeof key !== "string" || key.length === 0) continue;
    report.found.push(key);
    options.log(
      "warn",
      `⚠ yetim iş: ${key} kapıda bekliyordu, motor yeniden başladı — devam etmek için ` +
        "ticket'ı Maestro Bot'a atayın (analiz zaten ticket'te)",
    );

    // Ticket'a tek seferlik yorum — işaret zaten varsa atla (çift-yorum engeli).
    try {
      const comments = await options.work.listComments(key as TicketKey);
      if (comments.some((comment) => commentCarriesMarker(comment))) {
        report.skippedExisting.push(key);
        options.log("dim", `→ ${key}: yeniden-başlama yorumu zaten var — atlandı`);
        continue;
      }
      await options.work.addComment(key as TicketKey, orphanCommentText());
      report.commented.push(key);
    } catch (error) {
      // Yorum yazılamaması görünürlüğü öldürmez: günlük satırı zaten düştü.
      options.log("warn", `! yetim iş yorumu yazılamadı (${key}): ${String(error)}`);
    }
  }
  return report;
}
