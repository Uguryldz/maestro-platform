-- Ajan-hedefli bilgi (öğren notu / yüklenen belge): NULL = herkese (bugünkü
-- davranış), dolu = yalnız o ajan variant'ının bağlamına girer. Additive —
-- mevcut notlar NULL kalır ve davranış birebir korunur.
ALTER TABLE "AnalysisGuidance" ADD COLUMN "variantId" VARCHAR(64);
CREATE INDEX "AnalysisGuidance_variantId_idx" ON "AnalysisGuidance"("variantId");
