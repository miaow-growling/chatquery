use anyhow::Result as AnyResult;
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use tokio::sync::mpsc;

use chatquery::model::{BackendMsg, DisplayResult};
use chatquery::store::Storage;
use chatquery::tui::app::App;
use chatquery::tui::event::{self, InputEvent};
use chatquery::tui::ui;

fn main() -> AnyResult<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    // 优先尝试分发 CLI / MCP 子命令
    let handled = runtime.block_on(async { chatquery::cli::dispatch(None).await })?;

    if handled {
        return Ok(());
    }

    let storage = Storage::open()?;

    runtime.block_on(async move {
        let mut app = App::new(storage)?;

        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;

        let (input_tx, input_rx) = std::sync::mpsc::channel();
        event::input_thread(input_tx);
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<BackendMsg>();

        let code = run_app(
            &mut terminal,
            &mut app,
            input_rx,
            &result_tx,
            &mut result_rx,
        )
        .await;

        // Always restore the terminal, even if the loop returned an error.
        disable_raw_mode()?;
        execute!(io::stdout(), LeaveAlternateScreen)?;
        code
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    input_rx: std::sync::mpsc::Receiver<InputEvent>,
    result_tx: &mpsc::UnboundedSender<BackendMsg>,
    result_rx: &mut mpsc::UnboundedReceiver<BackendMsg>,
) -> AnyResult<()> {
    loop {
        while let Ok(ev) = input_rx.try_recv() {
            let InputEvent::Key(k) = ev;
            if app.handle_key(k, result_tx) {
                return Ok(());
            }
        }

        while let Ok(msg) = result_rx.try_recv() {
            match msg {
                BackendMsg::Result(r) => {
                    let note = match &r {
                        DisplayResult::Table(t) => {
                            if t.truncated {
                                format!("{} 行（已截断，更多请加 LIMIT）", t.rows.len())
                            } else {
                                format!("{} 行", t.rows.len())
                            }
                        }
                        DisplayResult::Redis(red) => red.note.clone(),
                    };
                    app.result = Some(r);
                    app.running = false;
                    app.result_follow = true;
                    app.status = note;
                }
                BackendMsg::ChatToken(s) => app.push_chat_token(&s),
                BackendMsg::ChatTool(info) => app.push_chat_tool(info),
                BackendMsg::ChatPlan(steps) => {
                    app.push_chat_token(&format!(
                        "\n📋 执行计划：\n{}\n",
                        chatquery::llm::planner::render_plan(&steps)
                    ));
                }
                BackendMsg::ChatConfirm(req) => {
                    app.push_chat_tool(format!("需确认（TUI 暂不支持，已拒绝）: {}", req.sql));
                }
                BackendMsg::ChatDone => app.commit_chat_stream(),
                BackendMsg::ChatUsage(_u) => {}
                BackendMsg::ConnHealth(id, ok) => {
                    use chatquery::tui::app::ConnStatus;
                    app.conn_status.insert(
                        id,
                        if ok {
                            ConnStatus::Connected
                        } else {
                            ConnStatus::Failed
                        },
                    );
                }
                BackendMsg::Error(e) => {
                    app.status = format!("error: {}", e);
                    app.running = false;
                    app.chat_running = false;
                }
            }
        }

        terminal.draw(|f| ui::render(f, app))?;
        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
    }
}
