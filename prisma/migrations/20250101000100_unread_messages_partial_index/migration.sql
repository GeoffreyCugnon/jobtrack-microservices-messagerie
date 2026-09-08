-- Partial index backing "unread messages" lookups (kept small: only rows still unread).
CREATE INDEX idx_messages_unread ON "Message" ("conversationId") WHERE "readAt" IS NULL;
