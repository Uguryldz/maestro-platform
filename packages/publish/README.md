# @maestro/publish — antetli Word şablonu nasıl hazırlanır

1. Word'de kurumun kendi belgesini açın: antet (üstbilgi/altbilgi), logo görseli ve stiller belgeye normal şekilde konur — Maestro yüklenen `.docx`'i **patch'ler**, asla yeniden kurmaz; antet, logo (word/media) ve stiller çıktıya bayt bayt aynen taşınır (test: `test/binary-doc.test.ts` "ANTET GARANTİSİ").
2. Analizin dolacağı yerlere şu yer tutucuları düz metin olarak yazın: `{{baslik}}` (belge başlığı), `{{ticket}}`, `{{kosu}}` (koşu no), `{{sablon_surumu}}`, `{{kunye}}` (künye tablosu), `{{onay_tablosu}}`, `{{govde}}` (gövde/taşan bölümler) ve bölüm başına `{{bolum:1}}`, `{{bolum:2}}`, … (analiz şablonundaki sıra).
3. `{{govde}}` mutlaka bulunsun: şablonda slotu olmayan bölümler oraya eklenir; hiç yoksa ve açıkta bölüm kalırsa üretim güvenli şekilde REDDEDİLİR (bölüm sessizce düşmez).
4. Dosyayı Studio'nun "Doküman Şablonu" ekranından yükleyin — yükleme anında tarama hangi yer tutucuların bulunduğunu gösterir; eksik olanlar üretimde uyarı olarak raporlanır.
5. Yeni yükleme yeni versiyon yayınlar (append-only); pilot her belge üretiminde EN YÜKSEK versiyonu kullanır, restart gerekmez.
