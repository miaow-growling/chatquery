use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Clear, List, ListItem, Paragraph, Row, Table};
use ratatui::Frame;

use crate::db::mysql::QueryResult;
use crate::db::redis::RedisResult;
use crate::model::{ChatRole, DisplayResult};
use crate::tui::app::{App, ConnStatus, Focus};

/// Accent colors per panel for focus border highlighting.
fn focus_border_style(focus: Focus, panel: Focus) -> Style {
    if focus == panel {
        Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

pub fn render(f: &mut Frame, app: &App) {
    let size = f.area();
    // Bottom area: keybinding bar (1) + status bar (1)
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(2)])
        .split(size);

    // Top area: connections (25%) + right side (75%)
    let top = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(25), Constraint::Percentage(75)])
        .split(outer[0]);

    // --- Connections panel ---
    let conn_border = focus_border_style(app.focus, Focus::Connections);
    let conn_block = Block::default()
        .borders(Borders::ALL)
        .border_style(conn_border)
        .title("Connections");
    f.render_widget(&conn_block, top[0]);
    let items: Vec<ListItem> = app
        .store
        .list()
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let dot = match app.conn_status.get(&c.id) {
                Some(ConnStatus::Connected) => "\u{25cf}", // ● filled circle (green)
                Some(ConnStatus::Failed) => "\u{25cb}",   // ○ empty circle (red)
                None => "\u{25cb}",                        // ○ empty circle (gray)
            };
            let dot_color = match app.conn_status.get(&c.id) {
                Some(ConnStatus::Connected) => Color::Green,
                Some(ConnStatus::Failed) => Color::Red,
                None => Color::DarkGray,
            };
            let type_badge = match c.db_type {
                crate::db::connection::DbType::Mysql => "M",
                crate::db::connection::DbType::Redis => "R",
            };
            let selected = i == app.selected_conn && app.focus == Focus::Connections;
            let name_style = if selected {
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let line = Line::from(vec![
                Span::styled(dot, Style::default().fg(dot_color)),
                Span::raw(" "),
                Span::styled(c.name.clone(), name_style),
                Span::styled(format!(" {}", type_badge), Style::default().fg(Color::DarkGray)),
            ]);
            ListItem::new(line)
        })
        .collect();
    f.render_widget(List::new(items), conn_block.inner(top[0]));

    // --- Right side: Tab bar + content ---
    let right_outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(top[1]);

    // Tab bar
    let tab_line = Line::from(vec![
        Span::styled(
            " Query ",
            if app.focus == Focus::Editor {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ),
        Span::styled(
            " Chat ",
            if app.focus == Focus::Chat {
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            },
        ),
        Span::styled("  Ctrl+1/2 切换", Style::default().fg(Color::DarkGray)),
    ]);
    f.render_widget(Paragraph::new(tab_line), right_outer[0]);

    // Content area: upper (editor/chat) + lower (result/transcript)
    let content = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(right_outer[1]);

    match app.focus {
        Focus::Chat => {
            let chat_border = focus_border_style(app.focus, Focus::Chat);
            let edit_block = Block::default()
                .borders(Borders::ALL)
                .border_style(chat_border)
                .title("Chat");
            f.render_widget(&edit_block, content[0]);
            f.render_widget(&app.chat_textarea, edit_block.inner(content[0]));

            let res_block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title("Transcript");
            f.render_widget(&res_block, content[1]);
            let inner = res_block.inner(content[1]);
            f.render_widget(render_transcript(app, inner), inner);
        }
        _ => {
            let editor_border = focus_border_style(app.focus, Focus::Editor);
            let edit_block = Block::default()
                .borders(Borders::ALL)
                .border_style(editor_border)
                .title("Query");
            f.render_widget(&edit_block, content[0]);
            f.render_widget(&app.textarea, edit_block.inner(content[0]));

            let res_block = Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::DarkGray))
                .title("Result");
            f.render_widget(&res_block, content[1]);
            let inner = res_block.inner(content[1]);
            match &app.result {
                Some(r) => render_result(f, inner, app, r),
                None => f.render_widget(
                    Paragraph::new("（执行查询后在此显示结果）"),
                    inner,
                ),
            }
        }
    }

    // --- Bottom: keybinding bar + status bar ---
    let bottom = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Length(1)])
        .split(outer[1]);

    // Keybinding hints
    let hints = Line::from(vec![
        Span::styled("Ctrl+1 Query", Style::default().fg(Color::Cyan)),
        Span::raw(" | "),
        Span::styled("Ctrl+2 Chat", Style::default().fg(Color::Cyan)),
        Span::raw(" | "),
        Span::styled("Ctrl+3 Conns", Style::default().fg(Color::Cyan)),
        Span::raw(" | "),
        Span::styled("Ctrl+Enter/F5", Style::default().fg(Color::Cyan)),
        Span::raw(" 执行 | "),
        Span::styled("Ctrl+E", Style::default().fg(Color::Cyan)),
        Span::raw(" 导出 | "),
        Span::styled("PgUp/PgDn", Style::default().fg(Color::DarkGray)),
        Span::raw(" 滚动 | "),
        Span::styled("a/e/d", Style::default().fg(Color::DarkGray)),
        Span::raw(" 连接"),
    ]);
    f.render_widget(Paragraph::new(hints), bottom[0]);

    // Status line
    let spin = if app.running || app.chat_running { "running " } else { "" };
    let mcp_s = match app.mcp.as_ref() {
        Some(m) => format!("mcp={}", m.server_count()),
        None => "mcp=off".to_string(),
    };
    let mask_s = if crate::mask::masking_enabled() { "脱敏:开" } else { "脱敏:关" };
    let status = format!(
        " {}conns={} | llm={} | {} | {} | {}",
        spin,
        app.store.list().len(),
        if app.llm.enabled() { "on" } else { "off" },
        mcp_s,
        mask_s,
        app.status
    );
    f.render_widget(Paragraph::new(status).style(Style::default().fg(Color::DarkGray)), bottom[1]);

    // --- Modals ---
    if app.confirm_delete.is_some() {
        render_confirm(f, app);
    }
    if app.form.is_some() {
        render_form(f, app);
    }
}

fn render_confirm(f: &mut Frame, app: &App) {
    let area = f.area();
    let w = 42u16.min(area.width);
    let h = 5u16.min(area.height);
    let rect = Rect {
        x: (area.width.saturating_sub(w)) / 2,
        y: (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
        ..area
    };
    f.render_widget(Clear, rect);
    let name = app
        .store
        .get(app.confirm_delete.unwrap_or(0))
        .map(|c| c.name.clone())
        .unwrap_or_default();
    let block = Block::default().borders(Borders::ALL).title("删除连接?");
    f.render_widget(&block, rect);
    let inner = block.inner(rect);
    f.render_widget(
        Paragraph::new(format!("删除 '{}' ?  (y 确认 / 其他取消)", name))
            .style(Style::default().fg(Color::Yellow)),
        inner,
    );
}

fn render_form(f: &mut Frame, app: &App) {
    let area = f.area();
    let w = (area.width * 60 / 100).clamp(50, 72);
    let h = (area.height * 80 / 100).clamp(15, 22);
    let rect = Rect {
        x: (area.width.saturating_sub(w)) / 2,
        y: (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
        ..area
    };
    f.render_widget(Clear, rect);
    let form = app.form.as_ref().unwrap();
    let title = if form.editing_id.is_some() {
        "编辑连接"
    } else {
        "新增连接"
    };
    let block = Block::default().borders(Borders::ALL).title(title);
    f.render_widget(&block, rect);
    let inner = block.inner(rect);

    let labels = ["名称", "类型", "主机", "端口", "用户", "密码", "库"];
    let mut constraints: Vec<Constraint> = vec![Constraint::Length(2); 7];
    constraints.push(Constraint::Min(1));
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(inner);

    for i in 0..7usize {
        let active = i == form.field;
        let style = if active {
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        // Password field (i=5): mask when not actively editing
        if active && i != 1 {
            let hr = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Length(5), Constraint::Min(1)])
                .split(rows[i]);
            f.render_widget(
                Paragraph::new(format!("{:>4}:", labels[i])).style(style),
                hr[0],
            );
            f.render_widget(&form.textarea, hr[1]);
        } else {
            let val: String = if i == 1 {
                format!("{:?}  (← → 切换)", form.db_type)
            } else if i == 5 {
                // Password field: always mask in non-active display
                let pw = form.fields[4].clone();
                if pw.is_empty() { pw } else { "*".repeat(pw.len()) }
            } else {
                let idx = if i == 0 { 0 } else { i - 1 };
                form.fields[idx].clone()
            };
            let line = Line::from(vec![
                Span::styled(format!("{:>4}: ", labels[i]), style),
                Span::styled(val, style),
            ]);
            f.render_widget(Paragraph::new(line), rows[i]);
        }
    }

    f.render_widget(
        Paragraph::new("Ctrl+S 保存 | Esc 取消 | ↑↓ 切换字段")
            .style(Style::default().fg(Color::Gray)),
        rows[7],
    );
}

fn render_transcript(app: &App, area: Rect) -> Paragraph<'static> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    for m in &app.chat {
        let (label, color) = match m.role {
            ChatRole::User => ("你", Color::Green),
            ChatRole::Assistant => ("AI", Color::Cyan),
            ChatRole::Tool => ("🔧", Color::Yellow),
            ChatRole::System => ("系统", Color::Gray),
        };
        lines.push(Line::from(Span::styled(
            format!("{}: ", label),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )));
        for para in m.content.split('\n') {
            lines.push(Line::from(para.to_string()));
        }
    }
    if let Some(s) = &app.chat_streaming {
        lines.push(Line::from(Span::styled(
            "AI: ",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));
        for para in s.split('\n') {
            lines.push(Line::from(para.to_string()));
        }
    }
    let total = lines.len() as u16;
    let scroll = if app.chat_follow {
        total.saturating_sub(area.height)
    } else {
        app.chat_scroll
    };
    Paragraph::new(lines).scroll((scroll, 0))
}

fn render_result(f: &mut Frame, area: Rect, app: &App, r: &DisplayResult) {
    match r {
        DisplayResult::Table(t) => render_table(f, area, app, t),
        DisplayResult::Redis(red) => render_redis(f, area, app, red),
    }
}

fn render_table(f: &mut Frame, area: Rect, app: &App, r: &QueryResult) {
    if r.columns.is_empty() {
        f.render_widget(
            Paragraph::new("查询无结果集（可能是写操作 / DDL）。"),
            area,
        );
        return;
    }
    let header = Row::new(
        r.columns
            .iter()
            .map(|c| Cell::new(c.as_str()))
            .collect::<Vec<_>>(),
    )
    .style(Style::default().add_modifier(Modifier::BOLD));
    let w = (100u16 / r.columns.len().max(1) as u16).max(8);
    let widths: Vec<Constraint> = r.columns.iter().map(|_| Constraint::Percentage(w)).collect();
    let max_rows = area.height.saturating_sub(1) as usize;
    let total = r.rows.len();
    let start = if app.result_follow {
        total.saturating_sub(max_rows)
    } else {
        app.result_scroll as usize
    }
    .min(total);
    let end = (start + max_rows).min(total);
    let window: Vec<Row> = r.rows[start..end]
        .iter()
        .map(|row| Row::new(row.iter().map(|v| Cell::new(v.as_str())).collect::<Vec<_>>()))
        .collect();
    let table = Table::new(window, widths).header(header);
    f.render_widget(table, area);
}

fn render_redis(f: &mut Frame, area: Rect, app: &App, r: &RedisResult) {
    if r.lines.is_empty() {
        f.render_widget(Paragraph::new(r.note.clone()), area);
        return;
    }
    let multi = r.lines.len() > 1;
    let mut items: Vec<ListItem> = Vec::new();
    items.push(
        ListItem::new(format!("$ {}", r.command)).style(Style::default().fg(Color::Cyan)),
    );
    for (i, l) in r.lines.iter().enumerate() {
        let prefix = if multi {
            format!("{:>4}  ", i + 1)
        } else {
            String::new()
        };
        items.push(ListItem::new(format!("{}{}", prefix, l)));
    }
    if r.truncated {
        items.push(
            ListItem::new(r.note.clone()).style(Style::default().fg(Color::Yellow)),
        );
    }
    let total = items.len();
    let start = if app.result_follow {
        total.saturating_sub(area.height as usize)
    } else {
        app.result_scroll as usize
    }
    .min(total);
    let end = (start + area.height as usize).min(total);
    let window = items[start..end].to_vec();
    f.render_widget(List::new(window), area);
}
