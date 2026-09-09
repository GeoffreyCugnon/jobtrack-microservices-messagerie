-- Partial index backing the outbox drain query (kept small: only rows still
-- awaiting publication). Matches:
--   SELECT ... FROM "OutboxEvent"
--   WHERE "publishedAt" IS NULL AND "failedAt" IS NULL AND "nextAttemptAt" <= now()
--   ORDER BY "nextAttemptAt" ASC
CREATE INDEX "idx_outbox_pending"
  ON "OutboxEvent" ("nextAttemptAt")
  WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;
