# Koşu durumu: hangi kaynak doğruyu söyler

**Dal:** `gap-b10-b14-pii-changetype-audit-realmerge` (worktree, `18e794b` üstüne)
**Commit:** aşağıda (bkz. "Commit")

## Sorun

Uzlaştırıcı (`18e794b`) veritabanını düzeltti, ama pano hâlâ yalan söylüyordu — ikinci katman:

```
DB gerçeği:   fail=11  running=4  done=1
UI gösterdiği: running=12  gate=3  done=1
```

`apps/bff/src/routes/studio-runs.ts` her satır için `deps.runs.queryRunState()` çağırıyordu, yani
durumu **yalnız Temporal'dan** okuyordu. `RunRecord` bir durum alanı taşımadığı için listenin ikinci
bir kaynağı yoktu.

Motor arızalı değil: retry'ları tükenen bir workflow aktivitenin **içinde** ölür, bu yüzden nasıl
bittiğini kaydedecek koda hiç ulaşamaz. Temporal da workflow'un yazabildiği son duruma göre cevap
verir — yani ölen adım, süresiz olarak `running`. Ölü iş operatörün panosunda canlı görünüyordu.

## Kaynak seçimi kuralı

> **Kayıt terminal (`fail`/`done`/`cancelled`) ise DB kazanır; aksi halde motor kazanır.**

`reconciledState()` — `apps/bff/src/routes/studio-runs.ts`.

**Gerekçe, iki yarım da hak ediyor:**

- **Terminal kayıt kazanır.** Motorun cevabı yanlış değil, sadece durmuş bir geçmişi sadakatle
  raporluyor. Uzlaştırıcı ikisini karşılaştırıp kararı `WorkflowRun.status`'a yazıyor ve bu karar
  **platformun** kararı: platform bir koşuyu kapanmış sayıyorsa, motorun kendi geçmişi ne derse desin
  o koşu kapanmıştır.
- **Aksi halde motor kazanır.** Adım ilerlemesi motorda olur, satıra sonradan yazılır. Gerçekten canlı
  bir koşu için motor **daha taze** olandır. `running` yazan bir satırın altında workflow kapıya
  park etmişse, satır bayattır — ve orada `running` göstermek insan bekleyen bir onayı gizler.

**Fail-closed asimetrisi, beraberliği bozan şey bu:** bitmiş bir koşuyu aktif göstermek, bekleyen bir
onayı kimsenin bakmasına gerek olmayan işin arasına gömer; aktif bir koşuyu bitmiş göstermek ise
yalnızca fazladan bir bakış maliyeti. İki kaynak "bu koşu bitti mi" konusunda çelişince **"bitti"**
kazanır.

**`state: null` KORUNDU.** Motor cevap veremiyorsa satır yine listeleniyor — bu regresyon daha önce
yirmi iki koşuluk bir katalog üstüne "henüz workflow yok" bastırmıştı. Terminal bir kayıt için bile
uydurma state üretilmiyor: `WorkflowRunState` `runId` ve `step` istiyor, katalogda ikisi de yok, ve
uydurmak gerçek bir koşuya olmayan bir adım atfetmek olurdu.

## Değişiklikler

| Dosya | Değişiklik |
|---|---|
| `apps/bff/src/read-models.ts` | `RunRecord.status: WorkflowRunStatus \| null` — donmuş contracts'taki tip kullanıldı, yeni tip yaratılmadı |
| `apps/deploy/src/stores/read-runs.ts` | `RunCatalogRow.status` seçiliyor, `toRunRecord` satırdan aynen geçiriyor (default YOK) |
| `apps/bff/src/routes/studio-runs.ts` | `reconciledState()` + liste ve detay rotalarında kullanımı |
| `apps/demo-stack/src/seed/runs.ts` | demo kaydı da `status` taşıyor |

**Detay rotası da aynı kuralı uyguluyor** — listede `fail` görünen satır tıklanınca `running`'e geri
dönmemeli; aynı yalanın bir ekran derinliği olurdu.

**Durum filtresi de uzlaştırılmış değeri okuyor.** Aksi halde ölü işi aramak için `?status=fail`
diyen operatör boş sayfa alırdı.

## Testler

**35 test** `apps/bff/test/studio-runs.test.ts` (12 yeni), **+1** `apps/deploy/test/read-live.test.ts`.

Kanıtlananlar:
- DB `fail` + motor `running` → UI **`fail`** (ve `step` motorunki olarak korunuyor)
- DB `running` + motor `gate` → UI **`gate`** (canlı koşuda motor daha taze)
- `done`/`cancelled` de terminal, yalnız `fail` değil
- Motor susuyorsa satır **yine listeleniyor**, `state: null`
- Detay başlığı listeyle aynı kararı veriyor
- `?status=fail` uzlaştırılmış değeri buluyor, `?status=running` bulmuyor
- İki tarafın "bitti" tanımı aynı (davranışla; import ile değil — BFF `apps/deploy`'a bağımlı değil)

## Mutasyon kanıtı

| Mutasyon | Sonuç |
|---|---|
| Kaynak seçimi ters çevrildi (`!TERMINAL` → `TERMINAL`, motor hep kazanır) | **9 test kırıldı** |
| Terminal kayıt için `null` yerine state uyduruldu | **2 test kırıldı** |

İkisi de geri alındı; 35/35 yeşil.

## Kapı

`pnpm run gate --concurrency=1` → **64/64 görev, exit 0.**

## Canlı doğrulama (yalnız SELECT)

```
fail|11   running|4   done|1
OPS-33|fail   OPS-36|fail   OPS-38|fail
```

Rapor edilen tabloyla birebir. Bu değişiklikle o on bir satır artık `running`/`gate` değil **`fail`**
olarak görünüyor. Canlı veritabanına **yazılmadı**.

## ARAYÜZ İSTEKLERİ

**Yok.** `WorkflowRunStatus` donmuş `contracts`'ta zaten vardı ve yedi değeriyle birlikte kullanıldı;
`packages/contracts` ve `packages/ports` değiştirilmedi. `RunRecord` BFF'in kendi okuma modeli
(donmuş değil), değişiklik oraya sığdı. Yeni katalog anahtarı da eklenmedi — kullanıcıya görünen yeni
metin yok, dolayısıyla tr+en paritesi bozulmadı.

## Yapmadıklarım

- **Migration yok.** `WorkflowRun.status` sütunu ve `RunStatus` enum'u (yedi değer) zaten mevcut.
- **Studio istemcisine dokunulmadı.** `toRunRow` zaten `state?.status`'u okuyor ve `null`'ı em dash
  olarak basıyor; rota uzlaştırılmış state'i aynı alanda gönderdiği için ekranlar kendiliğinden
  doğruyu gösteriyor.
- **Sayfalama/yetki davranışı değiştirilmedi.** Kapsam hâlâ mağazadaki `WHERE`, `nextCursor` hâlâ
  mağazanın döndürdüğü satırlarla ilerliyor.
- **Uzlaştırıcıya dokunulmadı.** Satırı kim yazıyorsa o yazmaya devam ediyor; bu iş yalnız okuma
  tarafının hangi kaynağa inanacağı.
- **Canlı servisler yeniden başlatılmadı**, `main`'e merge edilmedi.
