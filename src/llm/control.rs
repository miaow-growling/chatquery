//! Per-turn control plane (ADR-AI-4).
//!
//! An agent turn is long-running: it streams tokens, calls tools, and may need
//! to *ask the user something* mid-flight. Both needs are inherently
//! out-of-band relative to the token stream, so they can't ride on the
//! streaming callback (`&mut dyn FnMut(&str) + Send` can neither await nor
//! abort).
//!
//! `TurnControl` is the side channel:
//! - **cancellation** — a shared flag plus a `Notify` so an in-flight
//!   `stream_chat` can be raced with `select!` and abandoned promptly;
//! - **confirmation** — a registry of `oneshot` senders. When the guardrail
//!   hits a write statement the agent registers a pending confirm, emits a
//!   `ChatConfirm` event, and awaits the receiver. The UI answers by calling
//!   back into `resolve`, which wakes the awaiting tool call.
//!
//! Deliberately Tauri-agnostic: the library only knows about ids and booleans,
//! so the TUI (or a test) can drive the same flow.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio::sync::Notify;

/// Monotonic counter feeding confirm ids. Combined with the turn id these are
/// unique across the process without pulling in a uuid dependency.
static SEQ: AtomicU64 = AtomicU64::new(1);

struct Inner {
    turn_id: String,
    cancelled: AtomicBool,
    /// Set by frontends that have no confirmation UI (the TUI): every write
    /// confirmation is auto-rejected instead of waiting for an answer that can
    /// never arrive.
    no_confirm_ui: AtomicBool,
    /// Woken on cancel so awaiting selects wake immediately.
    notify: Notify,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

/// Handle to one turn's control plane. Cheap to clone (all state is shared);
/// the Tauri layer keeps a clone in `AppState` so `cancel_turn` /
/// `resolve_confirm` can reach a turn that is already running.
#[derive(Clone)]
pub struct TurnControl {
    inner: Arc<Inner>,
}

impl TurnControl {
    pub fn new(turn_id: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                turn_id: turn_id.into(),
                cancelled: AtomicBool::new(false),
                no_confirm_ui: AtomicBool::new(false),
                notify: Notify::new(),
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Declare that this frontend cannot prompt the user, so write
    /// confirmations should be refused immediately rather than blocking the
    /// turn on an answer nobody can give. Does *not* cancel the turn.
    pub fn cancel_confirmations_only(&self) {
        self.inner.no_confirm_ui.store(true, Ordering::SeqCst);
    }

    pub fn turn_id(&self) -> &str {
        &self.inner.turn_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Cancel the turn. Any pending confirmations are auto-rejected so the
    /// tool calls waiting on them unblock instead of hanging forever.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.reject_all();
        self.inner.notify.notify_waiters();
    }

    /// Resolves as soon as the turn is cancelled. Use in `tokio::select!` to
    /// abandon an in-flight LLM stream. If cancellation already happened this
    /// returns immediately.
    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            self.inner.notify.notified().await;
        }
    }

    /// Register a pending confirmation, returning its id and the receiver the
    /// caller should await. If the turn is already cancelled — or the frontend
    /// has no confirmation UI — the receiver resolves to `false` immediately,
    /// so callers never need a separate "can I even ask?" check.
    pub fn register_confirm(&self) -> (String, oneshot::Receiver<bool>) {
        let id = format!(
            "{}-c{}",
            self.inner.turn_id,
            SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        if self.is_cancelled() || self.inner.no_confirm_ui.load(Ordering::SeqCst) {
            let _ = tx.send(false);
            return (id, rx);
        }
        self.inner.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Answer a pending confirmation. Returns false if the id is unknown
    /// (already answered, or the turn moved on).
    pub fn resolve(&self, id: &str, approved: bool) -> bool {
        let sender = self.inner.pending.lock().unwrap().remove(id);
        match sender {
            Some(tx) => tx.send(approved).is_ok(),
            None => false,
        }
    }

    /// Reject every outstanding confirmation (used on cancel / teardown).
    fn reject_all(&self) {
        let drained: Vec<_> = self
            .inner
            .pending
            .lock()
            .unwrap()
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in drained {
            let _ = tx.send(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_ids_are_unique() {
        let c = TurnControl::new("t1");
        let (a, _ra) = c.register_confirm();
        let (b, _rb) = c.register_confirm();
        assert_ne!(a, b);
        assert!(a.starts_with("t1-c"));
    }

    #[tokio::test]
    async fn resolve_wakes_the_waiter() {
        let c = TurnControl::new("t2");
        let (id, rx) = c.register_confirm();
        assert!(c.resolve(&id, true));
        assert_eq!(rx.await.unwrap(), true);
        // Second resolve of the same id is a no-op.
        assert!(!c.resolve(&id, true));
    }

    #[tokio::test]
    async fn cancel_rejects_pending_confirms() {
        let c = TurnControl::new("t3");
        let (_id, rx) = c.register_confirm();
        c.cancel();
        assert!(c.is_cancelled());
        assert_eq!(rx.await.unwrap(), false);
        // `cancelled()` returns immediately once the flag is set.
        c.cancelled().await;
    }
}
