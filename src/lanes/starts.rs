//! Cancellation and completion ownership for lane startups, including scheduled retries.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use tokio::sync::{Notify, watch};

#[derive(Default)]
pub(super) struct Starts {
    pub(super) stopping: AtomicBool,
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
    finished: Notify,
}

pub(super) struct Starting<'a> {
    starts: &'a Starts,
    key: String,
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        self.starts
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.key);
        self.starts.finished.notify_waiters();
    }
}

impl Starts {
    pub(super) fn enter(&self, key: &str) -> Result<(Starting<'_>, watch::Receiver<bool>), String> {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if self.stopping.load(Ordering::Acquire) {
            return Err("the hub is stopping; lane startup is held".into());
        }
        if active.contains_key(key) {
            return Err("another startup still owns this lane".into());
        }
        let (send, receive) = watch::channel(false);
        active.insert(key.to_string(), send);
        Ok((
            Starting {
                starts: self,
                key: key.to_string(),
            },
            receive,
        ))
    }

    pub(super) fn cancel(&self, key: &str) {
        if let Some(send) = self
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
        {
            send.send_replace(true);
        }
    }

    pub(super) async fn cancel_all(&self) {
        self.stopping.store(true, Ordering::Release);
        {
            let active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
            for send in active.values() {
                send.send_replace(true);
            }
        }
        self.wait(None).await;
    }

    pub(super) async fn wait(&self, key: Option<&str>) {
        loop {
            // Register before checking so the last guard's completion cannot be missed.
            let finished = self.finished.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            let done = {
                let active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
                key.map_or_else(|| active.is_empty(), |key| !active.contains_key(key))
            };
            if done {
                return;
            }
            finished.await;
        }
    }
}
