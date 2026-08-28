-- Faz 3 (akış→ajan eşlemesi): a listening rule may name WHICH agent variants
-- its flow runs under. NULLable on purpose — NULL keeps today's behaviour
-- (the platform defaults analyst-default / engineer-default), so this is a
-- purely additive migration: existing rules keep working unchanged.
ALTER TABLE "ListeningRule" ADD COLUMN "analystVariantId" VARCHAR(64);
ALTER TABLE "ListeningRule" ADD COLUMN "engineerVariantId" VARCHAR(64);
