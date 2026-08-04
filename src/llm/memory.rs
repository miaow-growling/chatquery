use std::collections::VecDeque;

/// Lightweight working memory for an agent turn (and, later, across turns via
/// the session). Keeps the current connection/db and a bounded log of recent
/// tool results so the model doesn't re-derive context every step.
#[derive(Default, Clone)]
pub struct SessionMemory {
    pub current_conn: Option<String>,
    pub current_db: Option<String>,
    pub last_results: VecDeque<String>,
}

impl SessionMemory {
    pub fn new(conn: Option<String>, db: Option<String>) -> Self {
        Self {
            current_conn: conn,
            current_db: db,
            last_results: VecDeque::new(),
        }
    }

    /// Record a short label for the most recent tool result (bounded to 8).
    pub fn note_result(&mut self, label: &str) {
        self.last_results.push_back(label.to_string());
        if self.last_results.len() > 8 {
            self.last_results.pop_front();
        }
    }
}
