//! Complete stock catalog from docs/design/hosted-tools.md; new stock names require classification.
//! Pure policy data: no feature here forces an owner's optional tool on.

use super::{Hiding, Role, SettingValue, Tool};

const ALL: &[Role] = &[
    Role::Lead,
    Role::Lane,
    Role::Subagent,
    Role::Reviewer,
    Role::LookOnly,
];
const LANES: &[Role] = &[Role::Lane, Role::Subagent, Role::LookOnly];

macro_rules! off {
    ($key:literal) => {
        Hiding::Features(&[($key, SettingValue::Bool(false))])
    };
}

macro_rules! tool {
    ($name:literal, $reason:literal, $hiding:expr) => {
        Tool {
            name: $name,
            reason: $reason,
            offered_in: ALL,
            hiding: $hiding,
            unavailable_helpers: &[],
            inspection: false,
        }
    };
}

pub(crate) const STOCK: &[Tool] = &[
    Tool {
        inspection: true,
        ..tool!("read", "inspection", Hiding::LaunchSelection)
    },
    tool!("write", "author files", Hiding::LaunchSelection),
    tool!(
        "edit",
        "modify files",
        Hiding::Features(&[("edit.mode", SettingValue::Text("none"))])
    ),
    tool!(
        "bash",
        "necessary execution; outer-line guard only",
        off!("bash.enabled")
    ),
    Tool {
        inspection: true,
        ..tool!("grep", "search", off!("grep.enabled"))
    },
    Tool {
        inspection: true,
        ..tool!("glob", "search", off!("glob.enabled"))
    },
    tool!(
        "ast_grep",
        "optional structural search",
        off!("astGrep.enabled")
    ),
    tool!("ast_edit", "structural edits", off!("astEdit.enabled")),
    Tool {
        offered_in: &[],
        unavailable_helpers: &[
            "commit.draft",
            "browser.open",
            "help://eval/browser",
            "help://eval/computer",
            "help://eval/dsm",
        ],
        ..tool!(
            "eval",
            "decision 19; hide unavailable runtime helpers",
            Hiding::Features(&[
                ("eval.py", SettingValue::Bool(false)),
                ("eval.js", SettingValue::Bool(false)),
            ])
        )
    },
    tool!(
        "debug",
        "owner-enabled debugging, not containment",
        off!("debug.enabled")
    ),
    tool!(
        "lsp",
        "code intelligence; trusted executable configuration",
        off!("lsp.enabled")
    ),
    tool!("find", "optional semantic search", off!("find.enabled")),
    tool!(
        "task",
        "delegation with inherited hosted policy",
        Hiding::Features(&[("task.maxRecursionDepth", SettingValue::Number(0))])
    ),
    tool!("wait", "coordination", Hiding::LaunchSelection),
    tool!("todo", "coordination", off!("todo.enabled")),
    tool!("ask", "owner questions", off!("ask.enabled")),
    tool!("web_search", "research", off!("web_search.enabled")),
    tool!("github", "optional repository work", off!("github.enabled")),
    tool!(
        "checkpoint",
        "optional session recovery",
        off!("checkpoint.enabled")
    ),
    tool!(
        "rewind",
        "optional session recovery",
        off!("checkpoint.enabled")
    ),
    tool!(
        "context_notes",
        "optional context management",
        off!("compaction.experimentalContextManagement")
    ),
    tool!(
        "new_context",
        "optional context management",
        off!("compaction.experimentalContextManagement")
    ),
    tool!(
        "retain",
        "optional owner memory backend",
        Hiding::Features(&[("memory.backend", SettingValue::Text("off"))])
    ),
    tool!(
        "recall",
        "optional owner memory backend",
        Hiding::Features(&[("memory.backend", SettingValue::Text("off"))])
    ),
    tool!(
        "reflect",
        "optional owner memory backend",
        Hiding::Features(&[("memory.backend", SettingValue::Text("off"))])
    ),
    tool!(
        "memory_edit",
        "optional memory maintenance",
        Hiding::Features(&[("memory.backend", SettingValue::Text("off"))])
    ),
    tool!(
        "learn",
        "optional owner learning",
        off!("autolearn.enabled")
    ),
    tool!(
        "manage_skill",
        "optional owner learning",
        off!("autolearn.enabled")
    ),
    tool!(
        "security_scan",
        "optional security workflow; may consume allowance",
        off!("security.enabled")
    ),
    Tool {
        offered_in: LANES,
        ..tool!(
            "goal",
            "lanes continue goals; lead and reviewer hold none",
            off!("goal.enabled")
        )
    },
    tool!("think", "optional scratchpad", off!("externalThinking")),
    tool!("yield", "structured child result only", Hiding::NoSwitch),
    tool!("resolve", "finish a proposed operation", Hiding::NoSwitch),
    tool!("reject", "discard a proposed operation", Hiding::NoSwitch),
    tool!("propose", "plan mode only", off!("plan.enabled")),
    tool!(
        "report_issue",
        "owner-consented diagnostics",
        off!("dev.autoqa")
    ),
];
