# Hosted tools: availability, approval and authority

Design proposal, 2026-11-27; **not implementation approval**. Base: Cataly 0.2.5.
PR [#300](https://github.com/vntrevx/Cataly/pull/300), Momentum96 (CLA accepted), identifies a real defect.

## Evidence and scope

Only this worktree, stock OMP, its shipped public documentation/settings, and #300 were used.
No owner configuration, sessions or credentials were read; no paid model or redemption call ran.
The installed executable reports `omp/19.2.1`; SHA-256:
`e8b937f9bf023baa147bdd300ad5421af0a6ef8b1f350c47a9a93d5fca94feca`.
The cached stock `@oh-my-pi/pi-coding-agent@19.1.1` package supplies versioned source/settings.
Its CLI could not run: it requires Bun >=1.4.4; installed Bun is 1.4.0. No version gate was bypassed.
The global npm package reports 17.4.0 and was **not** used as evidence for 19.x.
Thus runtime findings below are 19.2.1; 19.1.1 settings/gates are source-verified, not locally runtime-verified.
#300 reports successful 19.1.1 and 19.2.1 macOS contract runs; that is contributor evidence, not our run.

Sources (public documentation was read from the installed binary with `omp read omp://…:raw`):
- [Approval](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/approval-mode.md), especially tool commands and subagents.
- [Eval](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/tools/eval.md), [debug](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/tools/debug.md), [LSP](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/tools/lsp.md), [LSP config](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/lsp-config.md).
- [Read](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/tools/read.md), [task](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/tools/task.md), [MCP](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/mcp-config.md), [settings](https://github.com/can1357/oh-my-pi/blob/v19.2.1/docs/settings.md).
- Stock 19.1.1 package: `src/tools/{builtin-names,index,settings}.ts`, `src/eval/settings.ts`, `src/task/settings.ts`, `src/cli/usage-cli.ts`.
- Live 19.2.1 `omp --help` and `omp config list --json`, in a fresh isolated HOME and agent directory.
- Cataly: `src/omp/launch.rs:123-164`, `extension/cataly.ts:327-351,484-494`, `src/lanes/shell.rs:1-8,154-229`, `src/hub/socket.rs:221-250`, `src/lanes/review.rs:95-119`.

## Reproduction: actual requests, not overlay snapshots

Temporary copies of `tests/contract_{session,lanes,tern}.rs` reused `TestHub` and
`tests/support/model.rs::FakeModel`. They recorded `FakeModel::bodies()` at the real provider boundary.
Every run used `CARGO_TARGET_DIR=target/chk-htools`, `CATALY_CONTRACT_OMP=1` and the installed executable.
Two baseline tests passed: `lead_follows_the_owners_omp_approval_settings_in_stock_omp` and
`a_lane_subagent_is_held_by_shell_rules_and_eval_deny_in_stock_omp`.
Both passed again with only `eval.py: false` and `eval.js: false` added to the isolated profile;
Cataly's production overlay retained its deny. Product code was untouched.

Baseline request excerpts (tool names extracted from `tools[].function.name`, order retained):

```text
lead: read,bash,edit,ask,eval,glob,grep,task,wait,todo,web_search,write,cataly_lead
lane: read,bash,edit,ask,eval,glob,grep,task,wait,todo,web_search,write,goal,cataly_lane
sub:  read,bash,edit,eval,glob,grep,task,wait,web_search,write
```

The lane's first request preceded goal activation and lacked `goal`; later requests contained it.
**Each of these three roles** received this system/developer instruction verbatim:

> When committing, use the eval `commit` namespace (`d = await commit.draft()`, then `await d.commit("subject", ["- body"])`) rather than `git add`/`git commit`: it captures only the lines you and your subagents wrote, leaving other agents' staged and unstaged work untouched.

A forced harmless eval call returned, for lead and subagent:
`Tool "eval" is blocked by user policy.`
After both kernels were disabled, every captured coding request lacked eval and `commit.draft`;
the forced call returned `Tool eval not found`. The subagent bash call still returned:
`Blocked by shell rule 1 (command sha256 f5f7673f3e45c1cf). No command ran.`
This proves inherited subagent shell refusal and eval denial; it does not prove containment of subprocesses.

Four additional capture probes passed:
- Tern lead, stock OMP TUI through the harness's Tern stand-in: same baseline lead tool list and commit instruction.
- Actual look-only lane: `read,grep,glob,cataly_lane,report_issue`, then also `goal` after activation.
- Reviewer-equivalent stock `--print --no-session --approval-mode always-ask --tools=read,grep,glob`
  launch: `read,grep,glob,report_issue`; no eval/commit guidance. This tested the launch surface, not PR review orchestration.
- With `tools.commands: false`, a real hosted lead called `debug` and `lsp` directly. Temporary project
  `dap.json`/`lsp.json` selected `/bin/sh` adapters that wrote `DEBUG-RAN`/`LSP-RAN` marker files.
  Both markers existed despite handshake failures (`DAP adapter exited unexpectedly (code 0)` and
  `LSP error: Failed to initialize LSP server /bin/sh: EPIPE: broken pipe, write`). No bash tool call performed these writes.

Local evidence remains in ignored `target/htools-*-{baseline,requests}.json` and
`target/htools-settings-19.2.1.json`; temporary test files were removed, not committed.
Baseline request SHA-256: lead `94ab10caa16fa5cd47cae1b5ea3ec2320099f5c8f76744f52d3555e9470e4a03`;
lane/sub `6a4c5d80bbc23f61b3801f1f97ce602f3042fbda22ea673107ea753e61f71624`.

## Root cause

Cataly expresses its eval exception **only as execution approval**, while OMP constructs availability
and capability-dependent instructions from separate feature settings. Denial is deliberately not hiding:
`tools.approval.eval: deny` stops execution but leaves a reachable backend and hence an advertised tool.
The commit prelude consequently remains available in the model's instructions. This is a Cataly integration
contract mismatch, not evidence that OMP's approval resolver is broken.

The architectural defect is that no single Cataly policy describes both availability and approval,
and no stock-OMP test reconciles the complete effective surface against that policy. Existing tests proved
refusal, not absence. New/optional tools, mounted commands and runtime helpers can consequently bypass review.
The initial hypothesis is correct, with one important correction: a flat `tools[]` inventory is insufficient.

## Complete stock-tool inventory and controls

Stock default RPC requests expose the lists above **plus** `ast_edit`, `debug`, `lsp` as mounted tool commands.
The prompt explicitly says these run inside bash. The outer veto sees `debug …` or `lsp …`, not their child
processes, config-file commands or LSP build scripts. With commands disabled these become direct tools.
The all-direct capture also contained `resolve`, `reject`, `report_issue`; special commands are another surface.
No dedicated stock `browser`, `computer`, `ssh`, or `recipe` tool exists in these 19.x builtin catalogs.

The following catalog covers every stock builtin plus conditional/special tools. **O** = proposed offered
when OMP/owner enables it; **H** = proposed hidden+denied. O is not forced enablement or approval.
Execution column describes capability outside inspection of a model-authored bash line, not necessarily
an unrestricted command-string parameter. Network includes indirect subprocess/provider access.
**For every named tool**, denial is `tools.approval.<exact canonical name>: deny` in both versions.
The hide column gives the corresponding setting in **both 19.1.1 and 19.2.1**, unless explicitly stated otherwise.
`CLI omit` means exclude from an explicit `--tools=…` list; there is no general `tools.disabled` setting.

| Tool | Class / reason | Execution or network outside shell veto | Hide control |
| --- | --- | --- | --- |
| `read` | O: inspection | URL/MCP network; SSH runs remote fixed file commands; format converters run helpers | CLI omit; `fetch.enabled: false` only disables URL fetching |
| `write` | O: author files | SSH writes; internal URLs can message/wake agents or control jobs; can plant scripts/config | CLI omit |
| `edit` | O: modify files | Can plant executable config; LSP hooks can start processes | `edit.mode: none` (also forces bash available), or CLI omit |
| `bash` | O: necessary execution | Inspects submitted line only; scripts/children retain arbitrary execution/network | `bash.enabled: false` unless edit mode is `none`; CLI omit |
| `grep` | O: search | External/internal/SSH URL filesystem can reach network | `grep.enabled: false` |
| `glob` | O: search | Remote/internal URL traversal can reach network | `glob.enabled: false` |
| `ast_grep` | O: optional structural search | Native parser; URL/SSH filesystem may reach network | `astGrep.enabled: false` |
| `ast_edit` | O: structural edits | Writes after resolve; no general execution parameter | `astEdit.enabled: false` |
| `eval` | H: decision 19; avoid impossible instructions | Arbitrary Python/JS, subprocesses, imports, network, runtime helpers | **Both** `eval.py: false`, `eval.js: false`, plus `PI_PY=0` and `PI_JS=0` set last in every launch environment: these variables outrank `--config`, and stock refills unset or empty ones from project, agent and home `.env` files; `archive.enabled: false` explicitly disables its eval prelude without disabling `read history://…` |
| `debug` | O: owner-enabled debugging, not containment | Arbitrary adapter/debuggee launch, evaluate, memory mutation, remote attach | `debug.enabled: false` |
| `lsp` | O: essential code intelligence, trusted executable config | Configured servers; `cargo check`, `npx tsc`, `go build`, `pyright`; executeCommand | `lsp.enabled: false` / `--no-lsp` (also disables edit/write hooks) |
| `find` | O: optional semantic search | Judge/provider requests; not arbitrary shell source | `find.enabled: off` (enum `auto`, `on`, `off`; boolean `false` is rejected by stock 19.2.1) |
| `task` | O: delegation | Child tools, model calls, isolation helpers; child bash veto is inherited | `task.maxRecursionDepth: 0`, or CLI omit |
| `wait` | O: coordination | Waits for existing work; does not introduce arbitrary execution | CLI omit; gate also depends on async, IRC and launch availability |
| `todo` | O: coordination | Session metadata only | `todo.enabled: false` |
| `ask` | O: owner questions | UI/host dispatch, not arbitrary code | `ask.enabled: false` |
| `web_search` | O: research | Network/provider services | `web_search.enabled: false` |
| `github` | O: optional repository work | Runs gh/git, network and mutations; executable/config/helper trust applies | `github.enabled: false` |
| `checkpoint`, `rewind` | O: optional session recovery | Snapshot/session operations, not general command input | `checkpoint.enabled: false` hides both |
| `context_notes`, `new_context` | O: optional context management | Notes/context changes, not arbitrary code | `compaction.experimentalContextManagement: false` |
| `retain`, `recall`, `reflect` | O: optional owner memory backend | Backend network/model calls; supplied backend owns implementation | `memory.backend: off` |
| `memory_edit` | O: optional memory maintenance | Backend mutation | `memory.backend: off` (native tool belongs to mnemopi backend) |
| `learn`, `manage_skill` | O: optional owner learning | Memory calls / skill-file writes; future execution possible through written content | `autolearn.enabled: false` |
| `security_scan` | O: optional security workflow | Launches review work; cloud scan can consume allowance | `security.enabled: false` |
| `goal` | O: lanes only; H: lead | Goal state/continuation; not arbitrary command source | `goal.enabled: false`; also absent without active goal |
| `think` | O: optional scratchpad | No arbitrary code/network action | `externalThinking: false` |
| `yield` | O: structured child result only | No arbitrary code/network action | Omit structured output requirement; no universal `yield.enabled` setting |
| `resolve`, `reject` | O: finish/discard proposed operations | Resolve executes a previously staged action; reject discards | No independent toggle; absent when no deferrable tools (stock: `ast_edit`) |
| `propose` | O: plan mode only | Plan submission, not general execution | `plan.enabled: false` removes applicable plan surface |
| `report_issue` | O: owner-consented diagnostics | Local report plus possible QA network upload | `dev.autoqa: false` |

Additional surfaces, not extra builtin names:
- Eval's `browser`, `computer`, `dsm`, `sh`, imports and subagent/completion helpers can execute or reach network.
  `browser.enabled: false` / `computer.enabled: false` hide their preludes; `commit.enabled: false` hides only
  commit guidance, **not eval**. A denied eval makes all its helpers inaccessible through that tool.
  `tools.approval.browser: deny` / `tools.approval.computer: deny` gate those helper dispatches, not arbitrary
  JS/Python alternatives; `tools.approval["computer.control"]: deny` separately refuses foreground takeover.
- `ssh://` is handled by read/write/search and the shell URL filesystem, not `tools.approval.ssh`.
  No stock `ssh.enabled` or `recipe.enabled` tool switch was found. Recipes are not a distinct authority surface here.
- MCP names are dynamic `mcp__<server>_<tool>` (sanitized/capped); extensions may choose arbitrary names.
  They can execute locally or remotely. Deny uses the **final exact registered name**, not a guessed wildcard.
  MCP hiding uses its separate `mcp.json` `disabledServers` or `mcpServers.<name>.enabled: false`;
  `instructions: false` suppresses that server's instructions, not its tools. `mcp.enableProjectConfig: false`
  only excludes project discovery. `--no-tools` suppresses MCP/extensions/LSP but also Cataly's bridge: not a drop-in fix.
- Disabling eval can **activate previously suppressed browser/node_repl MCP replacements** (OMP's documented
  builtin transforms). [INFERENCE] #300 can therefore expose another executor in an owner's configured profile;
  our empty-profile captures cannot measure that profile-dependent change.
- Cataly adds `cataly_lead` or `cataly_lane` (essential, policy allow, hub authorization per operation);
  the captured generic subagents have neither. They require explicit role rows alongside stock policy.
- OMP side requests included no-tool calls and a synthetic `submit_judgment` response schema. These are not
  agent-executable tools; separate request-purpose classification must keep them out of the coding-tool check.

Terminal lanes and remote-worker lanes use the same role launch/overlay design, but their optional tools depend
on the destination installation/profile. Only local Tern lead was measured; remote workers were not contacted.
Look-only/reviewer `--tools` is not an exhaustive security boundary: special tools are added, and enabled memory,
AST or extension features can widen a requested list. Subagent kinds/depth/output schemas also alter availability.
There is no finite truthful list of *all owner-configured* MCP/extension tools without enumerating that profile.

## What protects authority and money

**The shell veto is an accidental-command guard, not a security sandbox.** It catches recognizable Cataly
mutations/reset commands and mis-spelled direct-tool usage. It resolves some inline variables/quoted commands,
but cannot inspect arbitrary scripts, decoded `base64 … | sh`, inherited variables, aliases or later subprocesses.
Writing a script/config and then running it defeats any assertion that filtering the outer line contains execution.
Debug/LSP probes above demonstrate the second path without even a bash call. Do not grow a shell parser into a sandbox.

Hub operation authorization remains necessary: socket peer ancestry assigns lead/lane authority and dispatch checks it.
It is not isolation from hostile same-UID code: unplaced, tokenless callers are treated as Owner; external brokers,
reparented helpers and same-user filesystem access require a stronger threat model than process ancestry.

`NO_REDEEM` pins `codexResets.autoRedeem5h`, `codexResets.autoRedeemWeekly`,
`claudeResets.autoRedeem5h`, `claudeResets.autoRedeemWeekly`, `claudeResets.autoRedeemFable` to `no`.
These are all five live 19.2.1 auto-redeem keys, also present in 19.1.1. They prevent the configured OMP session's
**automatic** reset spending, not an independently launched CLI/API request. Stock 19.1.1 `usage-cli.ts:1475-1507`
resolves an explicit reset target and calls `authStorage.resets.redeem` without consulting auto-redeem settings.
[INFERENCE] Code with a usable provider/broker credential can invoke that path or the provider endpoint directly.
No such spend was attempted. Absence of a capable credential is an effective barrier; merely not passing a relay
secret is not: `session_env` permits owner-listed provider variables, and same-user OMP can discover stored auth.
Already-enabled paid overage, metered fallback models, auxiliary model tools and cloud scans are distinct costs;
`NO_REDEEM` does not turn them off, and an OMP cost ceiling is not a provider billing firewall.

Close a hard no-spend requirement at the credential/provider boundary: hosted code must have neither readable
account credentials nor a broad auth-broker token; use a separately protected, endpoint-restricted inference gateway
with server-side budgets, no reset/billing/account mutations, and provider-side overage disabled. Separate OS identity
or equivalent filesystem/process isolation must also protect owner state and the hub's owner-only control path.
Review remote workers and shared MCP/LSP brokers under that same boundary. A tool allowlist alone cannot provide it.

## Proposed design

1. One Rust hosted-tool policy table, analogous in ownership to `src/params.rs`, contains each known canonical name,
   O/H classification, reason, role applicability and a typed hiding strategy. Start with the catalog above:
   retain decision 19's eval exception; do **not** silently disable useful debugging/LSP in the name of nonexistent containment.
   Owner-disabled optional tools remain disabled. Offered does not set `policy: allow` or override owner approvals.
2. Generate hard hiding settings **and** `tools.approval.<name>: deny` from H rows, sharing the renderer across
   lead/lane, headless/Tern, worker and reviewer launches. Keep goal/session differences explicit. For tools without
   a feature gate, generate a launch selection where supported; acknowledge that overlay-only generation is insufficient.
   Never advertise a blocked capability's helper instructions. Do not regex-delete arbitrary prompt prose.
3. Runtime-available third-party tools need an explicit policy decision, not `mcp__* => safe`. Recommended contract:
   owner-configured extensions/MCP are trusted integrations outside the closed stock catalog, individually identified in
   a startup capability report; an optional strict profile admits only owner-reviewed exact names/sources before exposure.
   This report/strict mode must use OMP public extension APIs, not package imports or patches. Hiding tools does not
   sandbox extension startup, so strict hostile-code isolation is the separate credential design above.
4. Add one stock-OMP contract owner in the existing harness. Use the production table, record real requests and require
   witnesses for lead, active lane and a named subagent (not merely a nonempty combined log). Compare canonical tools,
   wire aliases, mounted command catalog and enabled runtime-helper instructions. Fail on unknown **stock** names,
   an H capability advertised anywhere, or its unavailable helper guidance (e.g. `commit.draft`). Normalize transport
   envelopes; assert capability references, not whole prose snapshots. Synthetic judgment schemas get a separate category.
5. Run default and `tools.commands: false` profiles, plus an optional-feature matrix so disabled-by-default additions
   are classified too. Exercise look-only/reviewer, Tern, nested/structured children, resume, delayed MCP registration
   and a fixture browser-MCP replacement with eval on/off. Inject calls to H names and prove no marker executes;
   keep the inherited bash refusal test. Test precedence with owner/project settings that try to re-enable H features.
6. Gate releases on this contract against latest stock OMP on Linux/macOS; keep the supported-minimum job too.
   Existing CI pins 19.1.1 on PRs and runs latest nightly/manual. Add latest to release/PR admission, not just advisory
   nightly results. A new tool is a public-surface addition requiring classification, not a reason to fork OMP.
   No runtime claim of fail-closed unknown-tool enforcement is made by a CI-only catalog.

Implementation slices (sizes are scope, not promises): **S** fold #300's eval gates and regression into the table;
**M** table/renderer plus all launch-role wiring and schema-key checks; **M** request-purpose/surface recorder and
witnessed contract matrix/latest CI gate; **S** publish guard/credential limits in decisions and operating docs;
**L**, separately approved, credential-isolated hosted execution if the owner requires adversarial no-spend guarantees.
The contract's red controls are removal of either hide gate, removal of denial, a new unknown fixture tool, and a
subagent missing inherited policy. Preserve owner approval dialogs and Cataly's essential direct tools.

## #300 verdict and owner decisions

**Correct, useful first slice; not the complete design.** Credit Momentum96 and fold its implementation into the
approved policy-table change (or merge it first if the owner authorizes the immediate usability fix). Its assertions
catch the observed eval/commit mismatch. They do not classify new executors, inspect mounted command/helper surfaces,
prove role-specific witnesses, cover Tern/reviewer/optional profiles, or account for MCP replacement activation.
A refusal of `not found` is correct when hidden; retaining deny remains defence in depth, not proof of sandboxing.

Owner decisions before implementation:
- Approve O/H defaults above, including offered debug/LSP and the continuing eval feature loss (browser/commit helpers)?
  If the real goal is containment, prefer the credential boundary rather than adding arbitrary tool bans.
- Are arbitrary owner-installed MCP/extensions trusted, or should strict hosted admission be mandatory?
- Is preventing accidental spending sufficient, or must same-UID/adversarial code be unable to spend or impersonate Owner?
- Make latest-OMP contract success release-blocking, accepting that newly offered stock tools require classification?
