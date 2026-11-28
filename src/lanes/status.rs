//! The lane's operational status, including unresolved delivery outcomes.

use std::fmt::Write as _;

use super::record::Record;
use super::{Lanes, evidence};
use crate::host::{Control, Runtime};
use crate::sys::now_ms;

impl<R: Runtime> Lanes<R> {
    /// The status view (EVR-29, COORD-45): one line per open lane, or one named lane.
    pub(super) async fn board(&self, key: Option<&str>) -> Result<String, String> {
        let rows = match key {
            Some(k) => self.row(k).await?.into_iter().collect(),
            None => self
                .env
                .store
                .read(|r| r.lanes(true))
                .await
                .map_err(|e| e.to_string())?,
        };
        let now = now_ms();
        let mut text = format!("{} lane(s)\n", rows.len());
        for row in rows {
            let Ok(rec) = serde_json::from_str::<Record>(&row.record) else {
                let _ = writeln!(text, "{}  unknown (record damaged)", row.key);
                continue;
            };
            let snap = self.session(&rec.key).map(|s| s.snapshot());
            let agent = snap.as_ref().map_or("gone".to_string(), |s| {
                format!("{:?}", s.status).to_lowercase()
            });
            let goal = snap
                .as_ref()
                .and_then(|s| s.goal.as_ref())
                .map_or("unknown".into(), |g| {
                    format!("{:?}", g.status).to_lowercase()
                });
            let approvals = snap.as_ref().map_or(0, |s| s.dialogs.len());
            let (k, run) = (rec.key.clone(), rec.run_id.clone());
            let last = self
                .env
                .store
                .read(move |r| r.reports(&k, Some(&run), 1))
                .await
                .ok()
                .and_then(|v| v.into_iter().next());
            let report = last.map_or("no report".into(), |r| {
                format!(
                    "{} {}: {}",
                    crate::jobs::instant_text(r.at_ms),
                    r.kind,
                    evidence::cut(&evidence::display(&r.text), 120)
                )
            });
            let _ = writeln!(
                text,
                "{} [{}] {} | {}m | agent {agent} | goal {goal} | approvals {approvals} | {}",
                rec.key,
                rec.thread.as_deref().unwrap_or("-"),
                rec.status(),
                (now - rec.opened_ms) / 60_000,
                report
            );
            if let Some(doubt) = self.delivery_doubt(&rec).await {
                let _ = writeln!(text, "  {doubt}");
            }
        }
        Ok(text)
    }
}
