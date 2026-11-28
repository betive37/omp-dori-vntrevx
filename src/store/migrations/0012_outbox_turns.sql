-- Schema v12 (additive): the turn whose final message a part carries (DISC-OUT req. 21, 25). 0 is
-- the answer; n the n-th later turn OMP started by itself, posted after the answer and never as the
-- reply. Every earlier part is an answer part.

ALTER TABLE outbox_parts ADD COLUMN turn INTEGER NOT NULL DEFAULT 0 CHECK (turn >= 0);
