-- Pin each part before sending: a lost acknowledgement never permits moving it elsewhere.
ALTER TABLE outbox_parts ADD COLUMN destination TEXT;
ALTER TABLE outbox_parts ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1));

-- Earlier versions posted only in the request's room. Pending legacy parts may already exist.
UPDATE outbox_parts SET destination = room, uncertain = (state = 'pending');
