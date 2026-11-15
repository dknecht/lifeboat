-- Lower-cased text of each message (subject, people, and the start of the body) for search.
ALTER TABLE messages ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

-- Conversations are read by thread within one user's mailbox.
CREATE INDEX idx_messages_thread ON messages(user_id, thread_id, received_at);
