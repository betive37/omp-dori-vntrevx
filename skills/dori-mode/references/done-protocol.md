# Lane done protocol

Give this file to every lane you launch.

When your lane's `Done =` signals are live and every change is pushed, claim done from your own session. The signals might be a PR merged, an issue closed or a version published. For local or QA-only work they can also be a command that passes, a file with the expected content, or a URL that answers (see `sessions.md`). Run them yourself first: the watcher re-runs every one and never takes your word for it.

```sh
dori claim-done <your-lane-key> --evidence "<report journal path:line; merge SHA, closed issue, version or other live Done receipts>"
```

The key is in your brief's lane footer. If you leave it out, the lane registered for your pane is used.

Before claiming done, persist the final report through the existing `report` command, using the footer's five lines: Outcome, Changes/findings, Verified, Unverified, and Handoff. Separate the requested result from observed checks and checks not run; include reasons and unresolved uncertainty rather than fabricated test names or empty placeholders. Investigation-only work reports findings and source evidence, not invented code changes. A partial result uses `milestone`, a blocker uses `blocker`, and cancellation uses `halted`; none is a completion claim. Only completed work whose entire `Done =` condition reads back live uses `done` and `claim-done`. Include the final report reference and those live receipts in the claim's evidence. The report reference is the configured `reports.jsonl` path plus the saved event's one-based line number; read that line back rather than guessing it. Do not paste the multiline report body into claim evidence. An output file, report or successful send alone does not establish acceptance.

## What happens next

1. The Dori gets a `LANE_DONE_CLAIMED` event, and you get a `[LEAD]` line saying when the lane closes.
2. Stay idle and start no new work.
3. If the Dori does not object within 5 minutes, the watcher closes the lane. Before closing, it reads back every `Done =` signal live. It refuses to close if any of your worktrees still has uncommitted tracked changes, or commits that are on no remote.
4. Closing marks your thread done (when a thread hook is configured), closes your tab, and removes your worktrees.

## If the Dori objects, or a check fails

You get `[LEAD] not done: <reasons>; keep working, claim again when fixed` in your pane, and the lane goes back to not-done. This happens when:

- the Dori objects;
- a `Done =` signal does not read back live;
- there is unpushed work (the reason names the path).

Fix every reason, then claim again. A new claim starts a fresh 5-minute window.
