-- Analysis guidance ("öğren" notes): the knowledge library an operator uploads
-- so the AI takes it into account when preparing a NEW analysis. Content is held
-- inline (short text notes, not stored blobs), and `enabled` toggles whether the
-- analyst learns from a note without deleting it.

-- CreateTable
CREATE TABLE "AnalysisGuidance" (
    "id" VARCHAR(64) NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AnalysisGuidance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisGuidance_enabled_idx" ON "AnalysisGuidance"("enabled");
