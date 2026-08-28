-- M101: MCP tool calls are audited with actor `ai-via:<user>`.
-- Enum values cannot be added inside a transaction on older PostgreSQL, and
-- Prisma wraps migrations, so this is written as an idempotent DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'AuditActionE' AND e.enumlabel = 'MCP_TOOL_CALL'
  ) THEN
    ALTER TYPE "AuditActionE" ADD VALUE 'MCP_TOOL_CALL';
  END IF;
END
$$;
