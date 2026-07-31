use anyhow::Result as AnyResult;
use clap::{Args, Parser, Subcommand, ValueEnum};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::execute;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use tokio::sync::mpsc;

use chatquery::db::connection::{ConnectionConfig, ConnectionStore, DbType};
use chatquery::model::{BackendMsg, DisplayResult};
use chatquery::store::Storage;
use chatquery::tui::app::App;
use chatquery::tui::event::{self, InputEvent};
use chatquery::tui::ui;

#[derive(Parser)]
#[command(name = "chatquery", about = "本地数据库终端工具 (Navicat 替代品)")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 添加一个数据库连接并持久化到本地 SQLite
    Add(AddArgs),
}

#[derive(Args)]
struct AddArgs {
    #[arg(long)] name: String,
    #[arg(long, value_enum)] r#type: DbTypeArg,
    #[arg(long)] host: String,
    #[arg(long, default_value_t = 0)] port: u16,
    #[arg(long, default_value = "")] user: String,
    #[arg(long, default_value = "")] password: String,
    #[arg(long, default_value = "")] database: String,
}

#[derive(ValueEnum, Clone, Copy)]
enum DbTypeArg {
    Mysql,
    Redis,
}

impl From<DbTypeArg> for DbType {
    fn from(v: DbTypeArg) -> Self {
        match v {
            DbTypeArg::Mysql => DbType::Mysql,
            DbTypeArg::Redis => DbType::Redis,
        }
    }
}

fn main() -> AnyResult<()> {
    let cli = Cli::parse();
    let storage = Storage::open()?;

    if let Some(Commands::Add(a)) = cli.command {
        let mut store = ConnectionStore::load(storage)?;
        store.add(ConnectionConfig {
            id: String::new(),
            name: a.name,
            db_type: a.r#type.into(),
            host: a.host,
            port: a.port,
            user: a.user,
            password: a.password,
            database: a.database,
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
        })?;
        println!("connection saved");
        return Ok(());
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

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
                BackendMsg::ChatDone => app.commit_chat_stream(),
                BackendMsg::ConnHealth(id, ok) => {
                    use chatquery::tui::app::ConnStatus;
                    app.conn_status.insert(id, if ok { ConnStatus::Connected } else { ConnStatus::Failed });
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
