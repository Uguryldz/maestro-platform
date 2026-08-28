/**
 * The analysis template a fresh installation starts with (M108).
 *
 * Why a default exists at all: the designer screen reads the PUBLISHED
 * template, and before the first publish there is none — `GET /template`
 * answers 404 `no_template` and the screen renders nothing an operator can
 * act on. A platform whose first screen is empty teaches its first user that
 * the feature is unfinished. So the installer publishes version 1, exactly the
 * way it seeds the operational parameters, and the bank edits from there.
 *
 * What this is NOT: sample text. Every section below is a question a Turkish
 * bank's change process genuinely asks of an analysis — purpose, scope,
 * impact, risk, acceptance — and the `aiInstruction` on each is a real
 * instruction that goes into the model's prompt. A template filled with
 * "Örnek bölüm 1" would be fabricated data dressed as configuration, and the
 * first analyst to open it would be reading a lie about what the institution
 * requires.
 *
 * It is a STARTING POINT, not a policy: version 1 is append-only like every
 * other version (M83), and a bank that publishes version 2 has simply moved
 * on. Nothing re-seeds over it — see `seedAnalysisTemplate`.
 *
 * The wording is Turkish because the platform's primary locale is Turkish
 * (M104) and these strings are the CONTENT of a document, not UI chrome: they
 * are what the analyst reads and what the model is told, and they are edited
 * in the designer rather than translated in a catalog.
 */

/** Mirrors `TemplateSection` in apps/bff/src/deps.ts — the wire shape. */
export interface DefaultTemplateSection {
  key: string;
  title: string;
  description: string;
  aiInstruction: string;
  required: boolean;
  format: "free_text" | "bullet_list" | "table" | "impact_matrix";
  example: string;
}

export const DEFAULT_ANALYSIS_TEMPLATE_NAME = "Standart analiz şablonu v1";

/**
 * Keys are the slugs `slugify()` derives from the titles, written out here so
 * this file is readable on its own. `test/template-defaults.test.ts` re-derives
 * them with the server's own function, so a title edited without its key is a
 * failing test rather than a template whose generated schema silently drops a
 * section.
 */
export const DEFAULT_ANALYSIS_TEMPLATE_SECTIONS: readonly DefaultTemplateSection[] = [
  {
    key: "amac_ve_gerekce",
    title: "Amaç ve gerekçe",
    description:
      "Bu değişikliğin neden yapıldığı ve yapılmazsa ne olacağı. İş biriminin talebi teknik bir cümleye çevrilir.",
    aiInstruction:
      "Ticket'taki talebi ve varsa bağlı olduğu iş gerekçesini oku. Değişikliğin amacını en fazla üç cümlede, " +
      "iş sonucu cinsinden yaz (hangi süreç, kim için, hangi ölçülebilir fayda). Talep metninde gerekçe yoksa " +
      "uydurma: \"Ticket'ta iş gerekçesi belirtilmemiş\" yaz ve gerekçeyi soracak şekilde açık bırak. " +
      "Teknik çözümü BURADA anlatma; o kapsam bölümünün işi.",
    required: true,
    format: "free_text",
    example:
      "Kredi başvuru ekranında müşterinin gelir belgesi yüklemesi zorunlu hale getirilecek. Bugün belge " +
      "sonradan isteniyor ve başvuruların yaklaşık beşte biri eksik evrak nedeniyle ikinci kez ele alınıyor.",
  },
  {
    key: "kapsam",
    title: "Kapsam",
    description:
      "Neyin değiştiği ve açıkça neyin değişmediği. Kapsam dışı maddeler kapsam kadar önemlidir.",
    aiInstruction:
      "Değişikliğin kapsamını iki başlıkta madde madde yaz: \"Kapsam içi\" ve \"Kapsam dışı\". Kapsam içi " +
      "maddeler dokunulacak ekran, servis, tablo ve entegrasyonları adıyla ansın. Kapsam dışı bölümünü boş " +
      "bırakma: incelemede en sık tartışılan nokta budur. Emin olmadığın bir bileşeni kapsam içi saymak " +
      "yerine kapsam dışına \"doğrulanmalı\" notuyla yaz.",
    required: true,
    format: "bullet_list",
    example:
      "Kapsam içi: başvuru formu ekranı, belge yükleme servisi, başvuru durum tablosu.\n" +
      "Kapsam dışı: mevcut başvuruların geriye dönük güncellenmesi, mobil uygulama akışı.",
  },
  {
    key: "etki_analizi",
    title: "Etki analizi",
    description:
      "Değişiklikten etkilenen sistemler, entegrasyonlar ve veri akışları; her biri için etkinin yönü ve büyüklüğü.",
    aiInstruction:
      "Etkilenen her bileşen için bir satır üret: bileşen adı, etkinin türü (kod, veri, sözleşme, " +
      "yapılandırma), etki düzeyi (düşük/orta/yüksek) ve kısa gerekçe. Yukarı ve aşağı yöndeki " +
      "entegrasyonları ayrı ayrı değerlendir. Depoda karşılığını göremediğin bir bileşeni tabloya " +
      "\"doğrulanmadı\" düzeyiyle ekle; sessizce atlama.",
    required: true,
    format: "impact_matrix",
    example:
      "Belge yükleme servisi · kod · yüksek · zorunluluk kontrolü burada uygulanacak\n" +
      "Başvuru veri modeli · veri · orta · yeni bir zorunlu alan ekleniyor\n" +
      "Arşiv entegrasyonu · sözleşme · düşük · alan adı değişmiyor, doluluk oranı artıyor",
  },
  {
    key: "veri_ve_gizlilik",
    title: "Veri ve gizlilik",
    description:
      "İşlenen kişisel/müşteri verisi, veri sınıfı ve saklama; KVKK ve banka içi veri politikası açısından durum.",
    aiInstruction:
      "Değişikliğin dokunduğu veriyi listele ve her biri için veri sınıfını (açık/dahili/gizli) belirt. " +
      "Yeni bir kişisel veri alanı ekleniyorsa, saklama süresi ve maskeleme ihtiyacını ayrıca yaz. " +
      "Kişisel veri işlenmiyorsa bunu açıkça \"Kişisel veri işlenmiyor\" diye belirt — boş bırakmak, " +
      "incelemede \"değerlendirilmedi\" olarak okunur.",
    required: true,
    format: "free_text",
    example:
      "Gelir belgesi (gizli): müşteriye ait finansal belge. Mevcut arşiv politikasına göre 10 yıl saklanıyor. " +
      "Belge içeriği log'lara yazılmayacak; yalnız belge kimliği loglanır.",
  },
  {
    key: "riskler_ve_onlemler",
    title: "Riskler ve önlemler",
    description:
      "Değişikliğin taşıdığı riskler ve her biri için alınan somut önlem. Önlemsiz risk, kabul edilmiş risktir ve öyle yazılır.",
    aiInstruction:
      "Her risk için bir satır yaz: risk, olasılık (düşük/orta/yüksek), etki (düşük/orta/yüksek) ve önlem. " +
      "Teknik risklerin yanında operasyonel riski de değerlendir (müşteri iletişimi, çağrı merkezi yükü, " +
      "geri alma zorluğu). Önlemi olmayan bir riski silme; \"önlem yok — kabul edilen risk\" yazarak bırak, " +
      "kararı onaycıya bırak.",
    required: true,
    format: "table",
    example:
      "Belge yükleyemeyen müşteri başvurusunu tamamlayamaz · orta · yüksek · geçiş döneminde eski akış " +
      "bayrakla açık tutulur\n" +
      "Belge boyutu limiti aşılır · yüksek · düşük · istemci tarafında boyut kontrolü ve anlaşılır hata mesajı",
  },
  {
    key: "geri_alma_plani",
    title: "Geri alma planı",
    description:
      "Değişiklik canlıda beklendiği gibi çalışmazsa nasıl geri alınacağı ve geri almanın sınırı.",
    aiInstruction:
      "Geri alma adımlarını sırayla yaz. Veri tarafında geri alınamayan bir işlem varsa (yapılmış şema " +
      "değişikliği, gönderilmiş bildirim, yazılmış müşteri kaydı) bunu ayrıca ve açıkça belirt: geri " +
      "alınabilirlik varsayımı, üretim olaylarında en pahalıya mal olan varsayımdır. Özellik bayrağıyla " +
      "kapatılabiliyorsa bayrağın adını yaz.",
    required: true,
    format: "free_text",
    example:
      "Zorunluluk kontrolü `basvuru.belge_zorunlu` bayrağıyla kapatılır; kod geri alınmadan eski davranışa " +
      "dönülür. Eklenen veri alanı boş bırakılabilir olduğu için şema geri alınmasına gerek yoktur.",
  },
  {
    key: "test_ve_kabul_kriterleri",
    title: "Test ve kabul kriterleri",
    description:
      "Değişikliğin doğru çalıştığını kanıtlayan, tek tek doğrulanabilir kriterler.",
    aiInstruction:
      "Kabul kriterlerini \"verildiğinde / yapıldığında / beklenen\" biçiminde, her biri tek başına " +
      "doğrulanabilir maddeler olarak yaz. En az bir olumsuz senaryo (hatalı/eksik girdi) ve en az bir " +
      "sınır durumu ekle. \"Sistem düzgün çalışmalı\" gibi ölçülemeyen ifade kullanma; her madde bir " +
      "test adımına çevrilebilmeli.",
    required: true,
    format: "bullet_list",
    example:
      "Belge yüklemeden devam denendiğinde başvuru ilerlemez ve eksik belge uyarısı gösterilir.\n" +
      "Desteklenmeyen dosya türü yüklendiğinde dosya reddedilir ve kabul edilen türler listelenir.\n" +
      "Belge yüklendiğinde başvuru bir sonraki adıma geçer ve belge kimliği başvuru kaydına işlenir.",
  },
  {
    key: "bagimliliklar",
    title: "Bağımlılıklar",
    description:
      "Bu değişikliğin beklediği dış koşullar: başka ekipler, sistemler, onaylar veya sıralama zorunlulukları.",
    aiInstruction:
      "Bu işin başlayabilmesi veya canlıya çıkabilmesi için önce tamamlanması gereken şeyleri listele: " +
      "başka bir ticket, bir ekip onayı, bir altyapı değişikliği, bir sözleşme güncellemesi. Sıralama " +
      "zorunluluğu varsa açıkça yaz. Bağımlılık yoksa \"Bağımlılık yok\" yaz; bölümü boş bırakmak " +
      "\"bakılmadı\" demektir.",
    required: false,
    format: "bullet_list",
    example:
      "Arşiv ekibinin belge tipi tanımını açması gerekiyor (ARSIV-412) — canlıya çıkıştan önce tamamlanmalı.",
  },
];
