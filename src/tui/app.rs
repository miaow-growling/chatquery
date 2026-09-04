use crate::config::{load_mcp_servers, LlmConfig};
use crate::db::connection::{ConnectionConfig, ConnectionStore, DbType};
use crate::llm::control::TurnControl;
use crate::llm::session::run_turn;
use crate::mcp::host::McpHostManager;
use crate::model::{BackendMsg, ChatMessage, DisplayResult};
use crate::store::Storage;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;
use tui_textarea::TextArea;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Connections,
    Editor,
    Chat,
}

impl fmt::Display for Focus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Focus::Connections => write!(f, "Connections"),
            Focus::Editor => write!(f, "Editor"),
            Focus::Chat => write!(f, "Chat"),
        }
    }
}

/// Cap chat history so memory stays bounded (ADR-006 spirit: never retain
/// unbounded state for a "background" feature).
const MAX_CHAT_MESSAGES: usize = 100;

/// Connection health status for the status-dot indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnStatus {
    Connected,
    Failed,
}

pub struct App {
    pub store: ConnectionStore,
    pub selected_conn: usize,
    pub textarea: TextArea<'static>,
    pub result: Option<DisplayResult>,
    pub status: String,
    pub running: bool,
    pub focus: Focus,
    pub llm: LlmConfig,
    pub chat: Vec<ChatMessage>,
    pub chat_textarea: TextArea<'static>,
    pub chat_streaming: Option<String>,
    pub chat_running: bool,
    pub mcp: Option<Arc<McpHostManager>>,
    // --- Bounded scrolling for long content (ADR-006 spirit: never render unbounded) ---
    pub chat_scroll: u16,
    pub chat_follow: bool,
    pub result_scroll: u16,
    pub result_follow: bool,
    // --- Connection management (Phase 6: in-TUI add/edit/delete) ---
    pub form: Option<ConnForm>,
    pub confirm_delete: Option<usize>,
    // --- Connection health status dots ---
    pub conn_status: HashMap<String, ConnStatus>,
}

/// Fields of the connection editor form. `fields` holds the six text values
/// (name, host, port, user, password, database); `db_type` is edited via the
/// arrow keys because it is a closed enum, not free text.
pub struct ConnForm {
    pub editing_id: Option<String>,
    pub fields: Vec<String>,
    pub db_type: DbType,
    pub field: usize,
    pub textarea: TextArea<'static>,
}

impl ConnForm {
    fn new() -> Self {
        let mut f = Self {
            editing_id: None,
            fields: vec![String::new(); 6],
            db_type: DbType::Mysql,
            field: 0,
            textarea: TextArea::default(),
        };
        f.load_active();
        f
    }

    fn from_cfg(c: &ConnectionConfig) -> Self {
        let mut f = Self {
            editing_id: Some(c.id.clone()),
            fields: vec![
                c.name.clone(),
                c.host.clone(),
                c.port.to_string(),
                c.user.clone(),
                c.password.clone(),
                c.database.clone(),
            ],
            db_type: c.db_type,
            field: 0,
            textarea: TextArea::default(),
        };
        f.load_active();
        f
    }

    /// Index into `fields` for the current text field (db_type field has none).
    fn text_index(&self) -> usize {
        if self.field == 0 {
            0
        } else {
            self.field - 1
        }
    }

    /// Persist the active textarea buffer back into `fields`.
    fn persist_active(&mut self) {
        if self.field != 1 {
            let idx = self.text_index();
            self.fields[idx] = self.textarea.lines().join("\n");
        }
    }

    /// Load the current field's value into the textarea for editing.
    fn load_active(&mut self) {
        let s = if self.field == 1 {
            String::new()
        } else {
            self.fields[self.text_index()].clone()
        };
        self.textarea = TextArea::new(vec![s]);
    }

    fn toggle_db_type(&mut self) {
        self.db_type = if self.db_type == DbType::Mysql {
            DbType::Redis
        } else {
            DbType::Mysql
        };
    }
}

impl App {
    pub fn new(storage: Storage) -> anyhow::Result<Self> {
        let store = ConnectionStore::load(storage)?;
        let llm = LlmConfig::from_env();
        let mcp_cfg = load_mcp_servers();
        let mcp = if mcp_cfg.is_empty() {
            None
        } else {
            Some(Arc::new(McpHostManager::new(mcp_cfg)))
        };
        let status = if llm.enabled() {
            format!(
                "ready — Ctrl+1/2/3 切换面板, Ctrl+Enter/F5 执行;  Chat: {}",
                llm.model
            )
        } else {
            "ready — Ctrl+1/2/3 切换面板,  Chat 未配置(设置 CHATQUERY_LLM_API_KEY)".into()
        };
        Ok(Self {
            store,
            selected_conn: 0,
            textarea: TextArea::default(),
            result: None,
            status,
            running: false,
            focus: Focus::Editor,
            llm,
            chat: Vec::new(),
            chat_textarea: TextArea::default(),
            chat_streaming: None,
            chat_running: false,
            mcp,
            chat_scroll: 0,
            chat_follow: true,
            result_scroll: 0,
            result_follow: true,
            form: None,
            confirm_delete: None,
            conn_status: HashMap::new(),
        })
    }

    /// Returns true when the app should quit.
    pub fn handle_key(&mut self, key: KeyEvent, result_tx: &UnboundedSender<BackendMsg>) -> bool {
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return true;
        }
        // Ctrl+1/2/3 direct focus switching (works regardless of current focus)
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('1') => {
                    self.focus = Focus::Connections;
                    return false;
                }
                KeyCode::Char('2') => {
                    self.focus = Focus::Editor;
                    return false;
                }
                KeyCode::Char('3') => {
                    self.focus = Focus::Chat;
                    return false;
                }
                _ => {}
            }
        }
        // Modals take precedence over focus routing.
        if self.form.is_some() {
            self.handle_form_key(key);
            return false;
        }
        if self.confirm_delete.is_some() {
            self.handle_confirm_key(key);
            return false;
        }
        match self.focus {
            Focus::Connections => match key.code {
                KeyCode::Up => {
                    if self.selected_conn > 0 {
                        self.selected_conn -= 1;
                    }
                }
                KeyCode::Down => {
                    if self.selected_conn + 1 < self.store.list().len() {
                        self.selected_conn += 1;
                    }
                }
                KeyCode::Tab => self.focus = Focus::Editor,
                KeyCode::Enter => self.focus = Focus::Editor,
                KeyCode::Char('a') => self.open_add(),
                KeyCode::Char('e') => self.open_edit(),
                KeyCode::Char('d') => {
                    if !self.store.list().is_empty() {
                        self.confirm_delete = Some(self.selected_conn);
                    }
                }
                _ => {}
            },
            Focus::Editor => match key.code {
                KeyCode::Tab => self.focus = Focus::Chat,
                KeyCode::F(5) => self.run_query(result_tx),
                KeyCode::Enter if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.run_query(result_tx)
                }
                KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.export_result();
                }
                KeyCode::PageUp => {
                    self.result_follow = false;
                    self.result_scroll = self.result_scroll.saturating_sub(10);
                }
                KeyCode::PageDown => {
                    self.result_scroll += 10;
                }
                KeyCode::End => {
                    self.result_follow = true;
                    self.result_scroll = 0;
                }
                _ => {
                    let _ = self.textarea.input(key);
                }
            },
            Focus::Chat => match key.code {
                KeyCode::Tab => self.focus = Focus::Connections,
                KeyCode::F(5) => self.run_chat(result_tx),
                KeyCode::Enter if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.run_chat(result_tx)
                }
                KeyCode::PageUp => {
                    self.chat_follow = false;
                    self.chat_scroll = self.chat_scroll.saturating_sub(10);
                }
                KeyCode::PageDown => {
                    self.chat_scroll += 10;
                }
                KeyCode::End => {
                    self.chat_follow = true;
                    self.chat_scroll = 0;
                }
                _ => {
                    let _ = self.chat_textarea.input(key);
                }
            },
        }
        false
    }

    // --- Connection form (add / edit) ---

    fn open_add(&mut self) {
        self.form = Some(ConnForm::new());
        self.status = "新增连接 — 填写后 Ctrl+S 保存".into();
    }

    fn open_edit(&mut self) {
        if let Some(c) = self.store.get(self.selected_conn).cloned() {
            self.form = Some(ConnForm::from_cfg(&c));
            self.status = "编辑连接 — 修改后 Ctrl+S 保存".into();
        }
    }

    fn handle_form_key(&mut self, key: KeyEvent) {
        let f = match &mut self.form {
            Some(f) => f,
            None => return,
        };
        match key.code {
            KeyCode::Esc => {
                self.form = None;
                self.status = "已取消".into();
            }
            KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.save_form();
            }
            KeyCode::Up => {
                f.persist_active();
                f.field = f.field.saturating_sub(1);
                f.load_active();
            }
            KeyCode::Down | KeyCode::Tab | KeyCode::Enter => {
                f.persist_active();
                f.field = (f.field + 1).min(6);
                f.load_active();
            }
            KeyCode::Left | KeyCode::Right if f.field == 1 => {
                f.toggle_db_type();
            }
            _ => {
                if f.field != 1 {
                    let _ = f.textarea.input(key);
                }
            }
        }
    }

    fn save_form(&mut self) {
        let f = match &mut self.form {
            Some(f) => f,
            None => return,
        };
        f.persist_active();
        let name = f.fields[0].trim().to_string();
        let host = f.fields[1].trim().to_string();
        if name.is_empty() || host.is_empty() {
            self.status = "名称和主机不能为空".into();
            return; // stay in the form
        }
        let editing_id = f.editing_id.clone();
        let mut cfg = editing_id
            .as_deref()
            .and_then(|id| self.store.list().iter().find(|c| c.id == id).cloned())
            .unwrap_or(ConnectionConfig {
                id: String::new(),
                name: String::new(),
                db_type: f.db_type,
                host: String::new(),
                port: 0,
                user: String::new(),
                password: String::new(),
                database: String::new(),
                ssl_mode: String::new(),
                ssl_ca: String::new(),
                client_cert: String::new(),
                client_key: String::new(),
                ssh_host: String::new(),
                ssh_port: 22,
                ssh_user: String::new(),
                ssh_auth_kind: String::new(),
                ssh_password: String::new(),
                ssh_private_key: String::new(),
                group_id: None,
            });
        cfg.id = editing_id.unwrap_or_default();
        cfg.name = name;
        cfg.db_type = f.db_type;
        cfg.host = host;
        cfg.port = f.fields[2].trim().parse().unwrap_or(0);
        cfg.user = f.fields[3].trim().to_string();
        cfg.password = f.fields[4].clone();
        cfg.database = f.fields[5].trim().to_string();
        let editing = f.editing_id.is_some();
        let _ = self.form.take();
        let res = if editing {
            self.store.update(cfg.clone())
        } else {
            self.store.add(cfg.clone())
        };
        match res {
            Ok(()) => {
                self.status = "连接已保存".into();
                if !editing {
                    self.selected_conn = self.store.list().len().saturating_sub(1);
                }
            }
            Err(e) => {
                self.status = format!("保存失败: {}", e);
                self.form = Some(ConnForm::from_cfg(&cfg));
            }
        }
    }

    fn handle_confirm_key(&mut self, key: KeyEvent) {
        let idx = match self.confirm_delete {
            Some(i) => i,
            None => return,
        };
        if matches!(key.code, KeyCode::Char('y') | KeyCode::Char('Y')) {
            if let Some(c) = self.store.get(idx).cloned() {
                let _ = self.store.remove(&c.id);
            }
            self.status = "连接已删除".into();
            if self.selected_conn >= self.store.list().len() {
                self.selected_conn = self.store.list().len().saturating_sub(1);
            }
        } else {
            self.status = "已取消".into();
        }
        self.confirm_delete = None;
    }

    fn run_query(&mut self, result_tx: &UnboundedSender<BackendMsg>) {
        let cfg = match self.store.get(self.selected_conn) {
            Some(c) => c.clone(),
            None => {
                self.status = "未选择连接".into();
                return;
            }
        };
        let text = self.textarea.lines().join("\n").trim().to_string();
        if text.is_empty() {
            self.status = "查询为空".into();
            return;
        }
        // Redis executes a single command line; MySQL takes the whole buffer.
        let redis_cmd = self
            .textarea
            .lines()
            .iter()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_default();
        self.running = true;
        self.status = format!("正在 {} 上执行...", cfg.name);
        let conn_id = cfg.id.clone();
        let tx = result_tx.clone();
        tokio::spawn(async move {
            let msg = match cfg.db_type {
                DbType::Mysql => match crate::db::mysql::query(&cfg, &text, None, false).await {
                    Ok(r) => {
                        let _ = tx.send(BackendMsg::ConnHealth(conn_id, true));
                        BackendMsg::Result(DisplayResult::Table(r))
                    }
                    Err(e) => {
                        let _ = tx.send(BackendMsg::ConnHealth(conn_id, false));
                        BackendMsg::Error(e.to_string())
                    }
                },
                DbType::Redis => match crate::db::redis::query(&cfg, &redis_cmd).await {
                    Ok(r) => {
                        let _ = tx.send(BackendMsg::ConnHealth(conn_id, true));
                        BackendMsg::Result(DisplayResult::Redis(r))
                    }
                    Err(e) => {
                        let _ = tx.send(BackendMsg::ConnHealth(conn_id, false));
                        BackendMsg::Error(e.to_string())
                    }
                },
            };
            let _ = tx.send(msg);
        });
    }

    fn run_chat(&mut self, result_tx: &UnboundedSender<BackendMsg>) {
        let input = self.chat_textarea.lines().join("\n").trim().to_string();
        if input.is_empty() {
            self.status = "对话为空".into();
            return;
        }
        if !self.llm.enabled() {
            self.status = "未配置 LLM：设置环境变量 CHATQUERY_LLM_API_KEY".into();
            return;
        }
        self.chat.push(ChatMessage::user(input.clone()));
        self.cap_chat();
        self.chat_textarea = TextArea::default();
        self.chat_running = true;
        self.chat_streaming = None;
        let mask_s = if crate::mask::masking_enabled() {
            " | 结果脱敏:开"
        } else {
            " | 结果脱敏:关"
        };
        self.status = format!("LLM ({}) 思考中...{}", self.llm.model, mask_s);

        let cfg = self.llm.clone();
        let conns: Vec<ConnectionConfig> = self.store.list().to_vec();
        let history: Vec<ChatMessage> = self.chat.clone();
        let mcp = self.mcp.clone();
        let tx = result_tx.clone();
        // The TUI has no confirmation modal and no stop key yet, so it gets a
        // control plane that is never signalled: writes will simply hang the
        // guardrail's confirm wait until the turn's own teardown rejects it.
        // Rather than that, cancel it up-front — writes stay refused in the
        // TUI, which matches the pre-existing behaviour.
        let ctl = TurnControl::new("tui");
        ctl.cancel_confirmations_only();
        let conn_id = self
            .store
            .get(self.selected_conn)
            .map(|c| c.id.clone())
            .unwrap_or_default();
        tokio::spawn(async move {
            match run_turn(
                &cfg,
                conns,
                mcp,
                &history,
                // The TUI has no SQL editor, so there is nothing to reference.
                &[],
                // The TUI has no conversation selector either — no @-mentions.
                None,
                &conn_id,
                // The TUI has no database picker — queries run against the
                // connection's configured default database.
                None,
                &tx,
                ctl,
                std::sync::Arc::new(|_, _| Vec::new()),
                std::sync::Arc::new(|_| {}),
            )
            .await
            {
                Ok(()) => {
                    let _ = tx.send(BackendMsg::ChatDone);
                }
                Err(e) => {
                    let _ = tx.send(BackendMsg::Error(format!("LLM: {}", e)));
                }
            }
        });
    }

    fn cap_chat(&mut self) {
        if self.chat.len() > MAX_CHAT_MESSAGES {
            let drop = self.chat.len() - MAX_CHAT_MESSAGES;
            self.chat.drain(0..drop);
        }
    }

    /// Commit streamed assistant text when an LLM turn completes.
    pub fn commit_chat_stream(&mut self) {
        if let Some(s) = self.chat_streaming.take() {
            if !s.trim().is_empty() {
                self.chat.push(ChatMessage::assistant(s));
                self.cap_chat();
            }
        }
        self.chat_running = false;
        self.chat_follow = true;
        self.status = "ready".into();
    }

    pub fn push_chat_token(&mut self, delta: &str) {
        let s = self.chat_streaming.get_or_insert_with(String::new);
        s.push_str(delta);
        self.chat_follow = true;
    }

    pub fn push_chat_tool(&mut self, info: String) {
        self.chat.push(ChatMessage::tool(info));
        self.cap_chat();
        self.chat_follow = true;
    }

    /// Export the current result to a CSV (table) or TXT (redis) file in the
    /// current directory. Triggered by Ctrl+E in Editor focus.
    fn export_result(&mut self) {
        let Some(r) = &self.result else {
            self.status = "没有可导出的结果".into();
            return;
        };
        let (content, ext) = match r {
            DisplayResult::Table(t) => (crate::db::mysql::to_csv(t), "csv"),
            DisplayResult::Redis(red) => (red.lines.join("\n"), "txt"),
        };
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = format!("chatquery-export-{}.{}", n, ext);
        match std::fs::write(&path, content) {
            Ok(()) => self.status = format!("已导出: {}", path),
            Err(e) => self.status = format!("导出失败: {}", e),
        }
    }
}
