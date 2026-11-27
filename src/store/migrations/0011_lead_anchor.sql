-- Proven bindings are identity records, not attempts. Their referenced attempt rows are retained.
CREATE TABLE lead_bindings (
    handle TEXT PRIMARY KEY REFERENCES sessions(handle),
    session_id TEXT NOT NULL,
    session_file TEXT NOT NULL,
    cwd TEXT NOT NULL,
    runtime TEXT NOT NULL,
    provenance TEXT NOT NULL,
    bound_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX lead_bindings_identity ON lead_bindings(session_id);
CREATE TABLE lead_anchor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    handle TEXT REFERENCES lead_bindings(handle),
    ever_started INTEGER NOT NULL DEFAULT 0,
    intent TEXT NOT NULL DEFAULT 'resume' CHECK (intent IN ('resume', 'fresh', 'fresh_failed')),
    hold TEXT
) STRICT;
INSERT INTO lead_bindings
SELECT handle, session_id, session_file, cwd, runtime, 'migrated exact binding', updated_ms
FROM sessions WHERE role = 'lead' AND session_id IS NOT NULL AND session_file IS NOT NULL
AND (fault IS NULL OR fault NOT LIKE 'model mismatch:%')
AND (mode = 'fresh' OR (expected_id = session_id AND expected_file = session_file));
INSERT INTO lead_anchor(singleton, handle, ever_started, intent, hold)
VALUES (1,
    (SELECT b.handle FROM lead_bindings b JOIN sessions s USING(handle)
     ORDER BY s.started_ms DESC, s.rowid DESC LIMIT 1),
    EXISTS(SELECT 1 FROM sessions WHERE role = 'lead'),
    CASE WHEN EXISTS(SELECT 1 FROM sessions f WHERE f.role = 'lead' AND f.mode = 'fresh'
               AND f.session_id IS NULL AND NOT EXISTS(
                   SELECT 1 FROM lead_bindings b JOIN sessions p USING(handle)
                   WHERE (p.started_ms, p.rowid) > (f.started_ms, f.rowid)))
         THEN 'fresh_failed' ELSE 'resume' END,
    CASE WHEN EXISTS(SELECT 1 FROM sessions WHERE role = 'lead')
              AND NOT EXISTS(SELECT 1 FROM lead_bindings)
         THEN 'no proven lead binding in migrated history' END);
-- Different locations/runtimes for one ID are retained, but never guessed between.
UPDATE lead_anchor SET hold = 'ambiguous lead binding history'
WHERE EXISTS(SELECT session_id FROM lead_bindings GROUP BY session_id
             HAVING COUNT(DISTINCT session_file || char(0) || cwd || char(0) || runtime) > 1);
-- The total (started_ms, rowid) ordering above selects the newest proven binding, including an
-- explicit fresh switch. Different conversation IDs alone are not ambiguous.
-- Episode accounting survives attempt retention and hub restarts. A completed episode is replaced
-- only by an explicit owner retry or a new failure after a successful binding.
CREATE TABLE startup_episodes (
    target TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    deadline_ms INTEGER NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0,
    next_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'held', 'cancelled', 'bound')),
    detail TEXT
) STRICT;
