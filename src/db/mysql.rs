use crate::db::connection::ConnectionConfig;
use crate::error::{AppError, Result};
use futures::TryStreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Max rows kept in memory per query result (ADR-006: bounded results).
pub const PAGE_LIMIT: usize = 200;
/// Hard ceiling for a single pager page. The UI offers 100..=1000; this guards
/// the channel against absurd values. Beyond 1000 the per-page memory and
/// WebView render cost grow fast, so keep it aligned with the UI max.
pub const MAX_PAGE_SIZE: usize = 1000;

#[derive(Debug, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// true when more rows exist beyond PAGE_LIMIT (user should add LIMIT).
    pub truncated: bool,
    /// Total row count when known (browse path fills this; arbitrary query
    /// leaves it None so the UI knows not to render a pager).
    pub total: Option<usize>,
    /// Primary-key column names for the browsed table (browse path only). Lets
    /// the UI locate a row for writes; empty for arbitrary SQL results.
    pub primary_keys: Vec<String>,
    /// Rows affected by a write statement (UPDATE/INSERT/DELETE/...). Some for
    /// write queries so the UI can show "N rows affected"; None for read-only
    /// queries and result-set queries.
    pub affected: Option<u64>,
    /// AUTO_INCREMENT id of the last INSERT, when the write produced one.
    pub last_insert_id: Option<u64>,
}

/// True when the error looks like a half-closed connection the server
/// dropped while the client thought it was still alive. Wraps the
/// "expected to read 4 bytes, got 0 bytes at EOF" symptom of stale
/// idle connections whose `test_before_acquire` ping raced the
/// server-side close.
///
/// 漏一次 EOF 不要紧——重连一次通常就好。sqlx 的 `test_before_acquire`
/// 本来该拦住，但时序上偶尔会漏（连接刚被 server 关，ping 还没发）。
/// 把这种错误重试一次能让长闲置后的首次查询自然恢复。
pub fn is_stale_connection_err(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(io) => matches!(
            io.kind(),
            std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
        ),
        // sqlx 把协议层的错误也包成 IoError(UnexpectedEof)，但有些
        // 版本会归到 Database 里并以 "expected to read N bytes" 形式出现。
        sqlx::Error::Database(db) => {
            let m = db.message();
            m.contains("got 0 bytes at EOF")
                || m.contains("expected to read")
                || m.contains("connection reset")
        }
        _ => false,
    }
}

/// Wrap an async DB op with stale-connection retry (up to 3 attempts).
/// Between attempts the connection's cached pool is invalidated, so each
/// retry builds a brand-new connection instead of drawing another possibly
/// dead one from the same pool.
///
/// sqlx 的 `test_before_acquire` ping 本应把死连接挡在 `acquire` 阶段，
/// 但它跟 server 端的 `wait_timeout` 关闭存在时序 race，ping 刚刚成功
/// 紧接着 server 就把 socket 关了——`fetch` / `execute` 就在管道里
/// 撞到 `got 0 bytes at EOF`。走 rdsproxy 这类代理时更糟：代理会按自己的
/// 空闲超时**整池**杀连接，单纯重试（从同一个池 acquire）大概率再撞一次。
/// 所以重试前先作废缓存池，让下一次尝试走全新建连；3 次之上不再叠——
/// 继续 retry 只会掩盖真正的网络/权限问题。
///
/// `database` 是闭包里连接池使用的库名（决定缓存池 key），与
/// `connect_pool` / `connect_pool_db` 的取库逻辑保持一致。
///
/// 闭包收到 `attempt`（1 起始）。`attempt >= 2` 表示之前每次尝试都死于
/// 连接 EOF：除了可能是空闲连接被杀，还有一种常见情形是 **rdsproxy 这类
/// 代理在 COM_STMT_PREPARE 报错时直接掐断连接**（如字段/表名写错，本应
/// 返回 1054 Unknown column）——EOF 把真实错误吞掉了。处理用户自由输入
/// SQL 的入口应在重试时切换到 TEXT 协议（`raw_sql`，不走 prepare）：代理
/// 对「COM_QUERY → ERR 包」这条最基本流程处理正确，能把真实错误透传回来。
///
/// ```ignore
/// with_stale_retry("mysql.browse", cfg, database, |attempt| async move {
///     let pool = connect_pool_db(cfg, database).await?;
///     let stmt = if attempt >= 2 { sqlx::raw_sql(sql) } else { sqlx::query(sql) };
///     stmt.fetch_all(&pool).await.map_err(AppError::Sqlx)
/// }).await
/// ```
async fn with_stale_retry<F, Fut, T>(
    label: &str,
    cfg: &ConnectionConfig,
    database: &str,
    mut op: F,
) -> Result<T>
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    const MAX_ATTEMPTS: usize = 3;
    for attempt in 1..=MAX_ATTEMPTS {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(AppError::Sqlx(e)) if is_stale_connection_err(&e) && attempt < MAX_ATTEMPTS => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "{label}: 闲置长连接超时，已自动刷新连接池并重试 ({}/{}) [{}]",
                    attempt + 1,
                    MAX_ATTEMPTS,
                    e
                );
                invalidate_pool_cache(cfg, database);
            }
            Err(other) => return Err(other),
        }
    }
    unreachable!("every loop branch returns")
}

/// Drop a connection's cached pool from the LRU table so the next
/// `get_pool` builds a fresh one. Deliberately does NOT `close()`: pools
/// still holding in-flight connections from concurrent tasks stay alive
/// until those finish; idle connections die with the final Arc drop.
fn invalidate_pool_cache(cfg: &ConnectionConfig, database: &str) {
    let key = pool_key(cfg, database);
    let mut g = pool_cache().lock().unwrap();
    if g.pools.remove(&key).is_some() {
        if let Some(pos) = g.order.iter().position(|k| k == &key) {
            g.order.remove(pos);
        }
    }
}

/// Execute a SQL string against MySQL and return a bounded, streamed result.
/// Only up to PAGE_LIMIT rows are retained in memory.
///
/// `database` selects the schema context for the query. When `None` (or empty)
/// the connection's default database is used — this is how ad-hoc SQL runs when
/// no specific database is selected in the tree. When set, the query connects
/// directly to that schema so unqualified table names resolve against it.
///
/// `allow_risky` permits UPDATE/DELETE statements without a top-level
/// WHERE/LIMIT (whole-table operations). The UI only sets it after the user
/// confirmed the confirm dialog; LLM/TUI callers leave it false so the backend
/// remains the last line of defense.
pub async fn query(
    cfg: &ConnectionConfig,
    sql: &str,
    database: Option<&str>,
    allow_risky: bool,
) -> Result<QueryResult> {
    // Stale-connection retry wrapper (2026-08-17). Long-idle pools
    // occasionally hand back a connection the server has already closed;
    // sqlx's `test_before_acquire` ping sometimes races the close and
    // EOF leaks through. One retry on a fresh pool entry is enough.
    let key_db = match database {
        Some(d) if !d.is_empty() => d,
        _ => cfg.database.as_str(),
    };
    with_stale_retry("mysql.query", cfg, key_db, |_attempt| {
        // 自由 SQL 查询直接走 TEXT 协议（raw_sql / COM_QUERY），避免云数据库
        // RDS Proxy 在 prepare 阶段因未知字段、语法或代理空闲掐线。
        query_once(cfg, sql, database, allow_risky, true)
    })
    .await
}

/// `text_mode`：走 TEXT 协议（`raw_sql`，不发 COM_STMT_PREPARE）。仅在
/// prepare 路径刚因连接 EOF 失败后开启——见 `with_stale_retry` 的文档：
/// rdsproxy 类代理会把 prepare 阶段的 SQL 错误（字段/表名不存在）转换成
/// 连接中断，只有 TEXT 协议能把真实的数据库错误透传回来。
async fn query_once(
    cfg: &ConnectionConfig,
    sql: &str,
    database: Option<&str>,
    allow_risky: bool,
    text_mode: bool,
) -> Result<QueryResult> {
    let pool = match database {
        Some(db) if !db.is_empty() => connect_pool_db(cfg, db).await?,
        _ => connect_pool(cfg).await?,
    };

    // Guardrail: refuse unguarded UPDATE/DELETE unless explicitly allowed.
    // Runs before the read/write routing below so multi-statement scripts are
    // covered too (SELECT 1; DELETE FROM t; → blocked).
    if !allow_risky {
        let risks = crate::sql_guard::analyze_write_sql(sql);
        if !risks.is_empty() {
            let previews: Vec<String> = risks.iter().map(|r| r.preview.clone()).collect();
            return Err(AppError::Msg(format!(
                "检测到 {} 条无 WHERE/LIMIT 条件的 UPDATE/DELETE 语句（将操作整表数据），已阻止执行：{}。若确需执行，请在确认弹窗中放行。",
                risks.len(),
                previews.join(" ；")
            )));
        }
    }

    // Write statements (INSERT/UPDATE/DELETE/DDL...) return no result set but
    // DO report rows_affected / last_insert_id. Route them through `execute`
    // so the UI gets real feedback ("影响 N 行 · 自增ID …") instead of a
    // silent 0-row table. Multi-statement scripts keep the legacy fetch path
    // (frontend already splits them, so this only guards direct callers).
    if !is_read_query(sql) && !has_unquoted_semicolon(sql.trim().trim_end_matches(';')) {
        let done = if text_mode {
            sqlx::raw_sql(sql)
                .execute(&pool)
                .await
                .map_err(AppError::Sqlx)?
        } else {
            sqlx::query(sql)
                .execute(&pool)
                .await
                .map_err(AppError::Sqlx)?
        };
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            truncated: false,
            total: None,
            primary_keys: vec![],
            affected: Some(done.rows_affected()),
            last_insert_id: Some(done.last_insert_id()),
        });
    }

    let mut stream = if text_mode {
        sqlx::raw_sql(sql).fetch(&pool)
    } else {
        sqlx::query(sql).fetch(&pool)
    };
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut count: usize = 0;
    let mut truncated = false;

    while let Some(row) = stream.try_next().await.map_err(AppError::Sqlx)? {
        if columns.is_empty() {
            for c in row.columns() {
                columns.push(c.name().to_string());
            }
        }
        if count < PAGE_LIMIT {
            rows.push(decode_row(&row).await);
            count += 1;
        } else {
            // 已达上限：标记截断即可，但**继续排空**剩余结果集。
            // 一旦 break，MySQL 连接会停在 streaming 脏状态；因为池现在是长生命周期
            // 缓存（不再 close），脏连接会被复用导致下次查询出错，所以更必须排空——
            // 慢库/高延迟网络上若不排空会卡住（表现为前端“执行超时”）。读够后继续
            // 丢弃超出行直至 EOF 才最干净。
            truncated = true;
        }
    }

    Ok(QueryResult {
        columns,
        rows,
        truncated,
        total: None,
        primary_keys: vec![],
        affected: None,
        last_insert_id: None,
    })
}

/// Paginated execution of an arbitrary SQL string — powers the result pager for
/// ad-hoc queries. Unlike `query` (which hard-truncates at PAGE_LIMIT and can
/// leave a dirty streaming connection), this rewrites the SQL to
/// `LIMIT page_size OFFSET page*page_size` and computes the true total via a
/// `SELECT COUNT(*) FROM (<sql>) AS _cq_sub` wrapper.
///
/// If the user already wrote a trailing `LIMIT n`, it is respected as a hard
/// cap: the total is `COUNT(*)` over the limited result set and every page is
/// drawn from those `n` rows. So `SELECT * FROM t LIMIT 1000` shows a total of
/// at most 1000 and produces at most `ceil(1000 / page_size)` pages. Only when
/// no user LIMIT is present does the pager compute/count against the full
/// result set. `page_size` is clamped to MAX_PAGE_SIZE so a single page never
/// blows up memory (ADR-006: bounded results).
pub async fn query_paged(
    cfg: &ConnectionConfig,
    sql: &str,
    database: Option<&str>,
    page: usize,
    page_size: usize,
    allow_risky: bool,
) -> Result<QueryResult> {
    // Only single SELECT statements can safely be wrapped with COUNT(*)
    // and LIMIT/OFFSET. SHOW/EXPLAIN/INSERT/UPDATE/DELETE or multi-statement
    // scripts must run through the plain query path (no pager, no rewrite).
    if !is_select_query(sql) {
        return query(cfg, sql, database, allow_risky).await;
    }

    // Stale-connection retry (2026-08-17): same race-the-ping issue as
    // `query` — the COUNT(*) probe or the page fetch can hit EOF when
    // sqlx's test_before_acquire ping raced the server-side close. Wrap
    // the whole post-routing body (pool acquire + COUNT + page stream);
    // each retry invalidates the cached pool so it re-connects fresh.
    let key_db = match database {
        Some(d) if !d.is_empty() => d,
        _ => cfg.database.as_str(),
    };
    with_stale_retry("mysql.query_paged", cfg, key_db, move |_attempt| async move {
        // 分页查询与自由 SQL 一并直接走 TEXT 协议（raw_sql / COM_QUERY），
        // 彻底规避云数据库 RDS Proxy 代理在 prepare 阶段掐线导致的 EOF 重试。
        let text_mode = true;
        let page_size = page_size.min(MAX_PAGE_SIZE).max(1);
        let offset = page.saturating_mul(page_size);
        let pool = match database {
            Some(db) if !db.is_empty() => connect_pool_db(cfg, db).await?,
            _ => connect_pool(cfg).await?,
        };

        let (base, user_limit) = strip_limit_offset(sql);

        // True total row count so the UI can render a pager. When the user already
        // supplied a LIMIT we wrap the limited query so COUNT respects that cap.
        // If the SQL is too exotic for COUNT (e.g. some top-level UNION shapes) we
        // leave total = None and the UI simply hides the pager.
        let count_sql = user_limit.map_or_else(
            || format!("SELECT COUNT(*) FROM ({}) AS _cq_sub", base),
            |limit| format!("SELECT COUNT(*) FROM ({} LIMIT {}) AS _cq_sub", base, limit),
        );
        let total: Option<usize> = if text_mode {
            sqlx::raw_sql(&count_sql)
                .fetch_one(&pool)
                .await
                .ok()
                .and_then(|r| r.try_get::<i64, _>(0).ok())
                .map(|n| n.max(0) as usize)
        } else {
            sqlx::query_scalar::<_, i64>(&count_sql)
                .fetch_one(&pool)
                .await
                .ok()
                .map(|n| n.max(0) as usize)
        };

        // If the user supplied a LIMIT, paginate inside a derived table so we never
        // return rows beyond their requested cap. TEXT 协议不支持 bind，直接内联
        // 内部生成的整数（page_size/offset/user_limit 均为本地数值，无注入面）。
        let page_sql = if text_mode {
            user_limit.map_or_else(
                || format!("{} LIMIT {page_size} OFFSET {offset}", base),
                |limit| format!(
                    "SELECT * FROM ({} LIMIT {limit}) AS _cq_limited LIMIT {page_size} OFFSET {offset}",
                    base
                ),
            )
        } else {
            user_limit.map_or_else(
                || format!("{} LIMIT ? OFFSET ?", base),
                |limit| format!(
                    "SELECT * FROM ({} LIMIT {}) AS _cq_limited LIMIT ? OFFSET ?",
                    base, limit
                ),
            )
        };
        let mut stream = if text_mode {
            sqlx::raw_sql(&page_sql).fetch(&pool)
        } else {
            sqlx::query(&page_sql)
                .bind(page_size as u64)
                .bind(offset as u64)
                .fetch(&pool)
        };
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<String>> = Vec::new();
        while let Some(row) = stream.try_next().await.map_err(AppError::Sqlx)? {
            if columns.is_empty() {
                for c in row.columns() {
                    columns.push(c.name().to_string());
                }
            }
            rows.push(decode_row(&row).await);
        }
        Ok(QueryResult {
            columns,
            rows,
            truncated: false,
            total,
            primary_keys: vec![],
            affected: None,
            last_insert_id: None,
        })
    })
    .await
}

/// Strip a trailing `LIMIT` clause (MySQL's `LIMIT n`, `LIMIT n, m`, and
/// `LIMIT n OFFSET m` forms) and return the maximum row cap the user asked for.
/// Only the statement tail is matched; a literal "LIMIT" inside a string that
/// isn't at the end is untouched. A trailing statement semicolon is also
/// removed when there was no LIMIT to consume it.
fn strip_limit_offset(sql: &str) -> (String, Option<usize>) {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\s*LIMIT\s+(\d+)\s*(?:(?:,\s*(\d+))|(?:OFFSET\s+(\d+)))?\s*;?\s*$")
            .unwrap()
    });
    let caps = re.captures(sql);
    let user_limit = caps.as_ref().and_then(|c| {
        // LIMIT offset, count  -> the second number is the cap
        if let Some(m) = c.get(2) {
            m.as_str().parse().ok()
        } else {
            // LIMIT count [OFFSET offset] -> the first number is the cap
            c.get(1)?.as_str().parse().ok()
        }
    });
    let stripped = re.replace(sql, "").trim_end().to_string();
    let base = if caps.is_some() {
        stripped
    } else {
        stripped.trim_end_matches(';').trim_end().to_string()
    };
    (base, user_limit)
}

/// Return true when `sql` is a single SELECT statement that we can safely wrap
/// with `COUNT(*)` and `LIMIT/OFFSET`. Anything else — SHOW, EXPLAIN, INSERT,
/// UPDATE, DELETE, CALL, or multi-statement scripts — must run unmodified.
///
/// A trailing statement semicolon is perfectly normal for a single SELECT and
/// must NOT disqualify it (it only terminates the one statement). We strip it
/// before classifying, so `SELECT * FROM t;` still paginates. Only *internal*
/// separators mark a multi-statement script that we must not rewrite.
fn is_select_query(sql: &str) -> bool {
    let no_tail = sql.trim().trim_end_matches(';').trim();
    let body = skip_leading_inline_comment(no_tail);
    let up = body.to_ascii_uppercase();
    let first = up.split(|c: char| c.is_whitespace()).next().unwrap_or("");
    if first != "SELECT" {
        return false;
    }
    !has_unquoted_semicolon(no_tail)
}

/// Return the effective top-level statement keyword. For a CTE, this is the
/// verb after the CTE definitions rather than `WITH`, so `WITH ... DELETE` is
/// never mistaken for a read.
pub fn statement_keyword(sql: &str) -> String {
    let no_tail = sql.trim().trim_end_matches(';').trim();
    let body = skip_leading_inline_comment(no_tail);
    let first = body
        .split(|c: char| c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    if first != "WITH" {
        return first;
    }

    let bytes = body.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = 4usize;
    let mut closed_cte = false;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == b'\\' {
                i = i.saturating_add(2);
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'\'' | b'"' | b'`' => {
                quote = Some(b);
                i += 1;
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                if depth > 0 {
                    depth -= 1;
                    if depth == 0 {
                        closed_cte = true;
                    }
                }
                i += 1;
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
            }
            _ if depth == 0 && closed_cte && (b as char).is_ascii_alphabetic() => {
                let start = i;
                while i < bytes.len()
                    && ((bytes[i] as char).is_ascii_alphanumeric() || bytes[i] == b'_')
                {
                    i += 1;
                }
                let word = body[start..i].to_ascii_uppercase();
                if matches!(
                    word.as_str(),
                    "SELECT"
                        | "INSERT"
                        | "UPDATE"
                        | "DELETE"
                        | "REPLACE"
                        | "CREATE"
                        | "ALTER"
                        | "DROP"
                        | "TRUNCATE"
                        | "SHOW"
                        | "EXPLAIN"
                        | "CALL"
                ) {
                    return word;
                }
            }
            _ => i += 1,
        }
    }

    // Unknown CTE shape: fail closed and route it as a write/non-read.
    "WITH".to_string()
}

/// True for statements that return a result set or otherwise read state.
pub fn is_read_query(sql: &str) -> bool {
    matches!(
        statement_keyword(sql).as_str(),
        "SELECT" | "SHOW" | "EXPLAIN" | "DESC" | "DESCRIBE" | "PRAGMA" | "HELP"
    )
}

/// Skip a leading `-- ` or `#` comment line so that `-- comment\nSELECT ...`
/// is still recognised as a SELECT. Multi-line `/* ... */` comments are rare
/// in ad-hoc queries; treating them as non-SELECT is the safe fallback.
fn skip_leading_inline_comment(s: &str) -> &str {
    if s.starts_with("--") {
        s.find('\n').map_or("", |i| s[i + 1..].trim_start())
    } else if s.starts_with('#') {
        s.find('\n').map_or("", |i| s[i + 1..].trim_start())
    } else {
        s
    }
}

pub fn is_single_statement(sql: &str) -> bool {
    let body = sql.trim().trim_end_matches(';').trim_end();
    !has_unquoted_semicolon(body)
}

/// True if the SQL contains a statement-terminating semicolon outside of
/// string literals. We only handle single/double quotes; backtick identifiers
/// are irrelevant because a semicolon inside a table name is not valid anyway.
fn has_unquoted_semicolon(sql: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for ch in sql.chars() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' => escape = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            ';' if !in_single && !in_double => return true,
            _ => {}
        }
    }
    false
}

async fn decode_row(row: &sqlx::mysql::MySqlRow) -> Vec<String> {
    let mut out = Vec::new();
    for c in row.columns() {
        let ord = c.ordinal();
        let is_null = row.try_get_raw(ord).map(|v| v.is_null()).unwrap_or(false);
        let v: String = if is_null {
            "NULL".to_string()
        } else if let Ok(Some(s)) = row.try_get::<Option<String>, _>(ord) {
            s
        } else if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(ord) {
            n.to_string()
        } else if let Ok(Some(n)) = row.try_get::<Option<u64>, _>(ord) {
            // 无符号整数列：sqlx 对带 UNSIGNED 标志的列拒绝 i64，必须用 u64
            // 接（YEAR / BIT 也带 UNSIGNED 标志，一并在此处理）。必须排在
            // bool 之前——bool 的兼容判定接受所有整数列，会把 200 解成 true。
            n.to_string()
        } else if let Some(f) = row
            .try_get::<Option<f32>, _>(ord)
            .ok()
            .flatten()
            .filter(|_| c.type_info().name() == "FLOAT")
        {
            // FLOAT 列按 f32 显示（Rust Display 输出最短往返表示，0.1 就是
            // "0.1"），否则 f64 分支会把 4 字节载荷展宽成 0.10000000149011612。
            // sqlx 的 f32 对 DOUBLE 列会截断到单精度，所以必须用列类型拦住，
            // DOUBLE 仍走下方 f64 分支保全程精度。
            f.to_string()
        } else if let Ok(Some(f)) = row.try_get::<Option<f64>, _>(ord) {
            f.to_string()
        } else if let Ok(Some(b)) = row.try_get::<Option<bool>, _>(ord) {
            b.to_string()
        } else if let Ok(Some(dt)) = row.try_get::<Option<NaiveDateTime>, _>(ord) {
            dt.to_string()
        } else if let Ok(Some(d)) = row.try_get::<Option<NaiveDate>, _>(ord) {
            d.to_string()
        } else if let Ok(Some(t)) = row.try_get::<Option<NaiveTime>, _>(ord) {
            t.to_string()
        } else if let Ok(Some(ts)) = row.try_get::<Option<DateTime<Utc>>, _>(ord) {
            ts.to_string()
        } else if let Ok(Some(n)) = row.try_get::<Option<sqlx::types::Decimal>, _>(ord) {
            n.to_string()
        } else if let Ok(Some(j)) = row.try_get::<Option<serde_json::Value>, _>(ord) {
            j.to_string()
        } else if let Ok(Some(bytes)) = row.try_get::<Option<Vec<u8>>, _>(ord) {
            bytes_to_display(&bytes)
        } else {
            "?".to_string()
        };
        out.push(v);
    }
    out
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Render a binary-typed value for display: if the bytes are valid UTF-8
/// without control characters, show the text itself; otherwise fall back to
/// `0x`-hex. MySQL sets the protocol BINARY flag on `_bin`-collation VARCHARs
/// (utf8mb4_bin 等), which makes sqlx refuse String decoding even though the
/// payload is plain text — those columns land in the Vec<u8> branch too.
fn bytes_to_display(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        if s.chars()
            .all(|c| !c.is_control() || c == '\t' || c == '\n' || c == '\r')
        {
            return s.to_string();
        }
    }
    format!("0x{}", to_hex(bytes))
}

/// Render a query result as CSV (UTF-8). Fields containing comma, quote, or
/// newline are quoted and inner quotes are doubled — enough for a local
/// export tool. Returns a string so it's unit-testable.
pub fn to_csv(r: &QueryResult) -> String {
    let mut s = String::new();
    s.push_str(
        &r.columns
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    s.push('\n');
    for row in &r.rows {
        s.push_str(
            &row.iter()
                .map(|v| csv_field(v))
                .collect::<Vec<_>>()
                .join(","),
        );
        s.push('\n');
    }
    s
}

fn csv_field(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') || v.contains('\r') {
        let escaped = v.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    } else {
        v.to_string()
    }
}

/// 连接池缓存层（根治短生命周期池的 EOF 与连接抖动问题）。
///
/// 设计权衡（用户要求限制内存）：
/// - 按物理连接（host/port/user/password，再分目标 database）缓存**长生命周期**池，
///   健康检查（test_before_acquire / max_lifetime）才真正稳定生效，绝不再拿到 server 已静默关闭的连接。
/// - **内存上限靠三层锁死**：① 每池 `max_connections` 封顶（单连接并发连接数）；
///   ② `idle_timeout` 让空闲连接在 30s 后归零（`min_connections(0)` 不保活），缓存只留几 KB 元数据；
///   ③ 全局 LRU 上限 `MAX_CACHED_POOLS`，超出淘汰最久未用的池并 close。
/// - 缓存 key 含 password：改密码 → key 变 → 自动换新池；删除连接 → 旧池被 LRU 淘汰，无需显式 invalidate。
const MAX_CONN_PER_POOL: u32 = 4;
/// 全局缓存连接池实例上限。每个实例本身只占 Arc 元数据（几 KB），真正的 TCP 连接在
/// idle_timeout 后回收，所以 64 个上限内存完全可控（典型场景活跃连接 < 20）。
const MAX_CACHED_POOLS: usize = 64;

struct PoolCache {
    pools: std::collections::HashMap<String, MySqlPool>,
    /// LRU 顺序：front = 最久未用，back = 最近使用。
    order: std::collections::VecDeque<String>,
}

static POOL_CACHE: std::sync::OnceLock<std::sync::Mutex<PoolCache>> = std::sync::OnceLock::new();

/// 清空所有缓存的 MySQL 连接池并异步关闭底层连接，释放套接字与内存资源。
pub fn clear_mysql_pool_cache() {
    if let Some(cache_mutex) = POOL_CACHE.get() {
        let mut g = cache_mutex.lock().unwrap();
        for (_, pool) in g.pools.drain() {
            tokio::spawn(async move {
                pool.close().await;
            });
        }
        g.order.clear();
    }
}

fn pool_cache() -> &'static std::sync::Mutex<PoolCache> {
    POOL_CACHE.get_or_init(|| {
        std::sync::Mutex::new(PoolCache {
            pools: std::collections::HashMap::new(),
            order: std::collections::VecDeque::new(),
        })
    })
}

/// 连接身份 key：同一物理库（host/port/user/password + 目标 database）视为一个池。
/// 不含 id/group（同物理库多配置共享池无害）；password 变化 → key 变 → 自动换新池。
/// 含 ssh_host：直连与经不同跳板机的隧道不能共用同一池。
fn pool_key(cfg: &ConnectionConfig, database: &str) -> String {
    // 空 database 直接用空串占位。绝不用 "mysql" 系统库兜底：托管账号（阿里云
    // RDS 等）通常无权访问 mysql 库，硬连会报 Access denied。
    format!(
        "{}:{}:{}:{}:{}:{}",
        cfg.host, cfg.port, cfg.user, cfg.password, database, cfg.ssh_host
    )
}

/// 实际建立连接（不含缓存）。参数统一收敛在此。
///
/// 支持两种进阶连接形态（均向后兼容旧明文数据，字段为空即退化为直连）：
/// - SSL/TLS：通过 `MySqlConnectOptions::ssl_*` 程序化构建，CA/证书可为文件路径
///   或内联 PEM 文本（`#4`）。
/// - SSH 隧道：当 `ssh_host` 非空时，先在本机起一条 `ssh -L` 本地转发，再连
///   127.0.0.1:本地端口（`#5` MVP）。隧道进程随连接池缓存长期存活，LRU 淘汰池时
///   一并 kill。
async fn connect_raw(cfg: &ConnectionConfig, database: &str) -> Result<MySqlPool> {
    // 空 database 时不指定默认库（MySQL 协议允许无当前库连接），避免无权访问
    // mysql 系统库的托管账号报 Access denied。
    let db = if database.is_empty() {
        None
    } else {
        Some(database)
    };

    // SSH 隧道：把逻辑目标 (cfg.host:cfg.port) 替换为本地转发端口。
    let (host, port) = if !cfg.ssh_host.is_empty() {
        let key = pool_key(cfg, database);
        let local_port = ensure_ssh_tunnel(&key, cfg)?;
        ("127.0.0.1".to_string(), local_port)
    } else {
        (cfg.host.clone(), cfg.port)
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&cfg.user)
        .password(&cfg.password)
        .charset("utf8mb4");
    if let Some(db) = db {
        opts = opts.database(db);
    }

    // SSL/TLS（#4）：ssl_mode 为空时退化为 MySQL 默认（Preferred，即“能加密就加密”）。
    if !cfg.ssl_mode.is_empty() {
        opts = opts.ssl_mode(parse_ssl_mode(&cfg.ssl_mode));
        if !cfg.ssl_ca.is_empty() {
            if Path::new(&cfg.ssl_ca).exists() {
                opts = opts.ssl_ca(Path::new(&cfg.ssl_ca));
            } else {
                opts = opts.ssl_ca_from_pem(cfg.ssl_ca.as_bytes().to_vec());
            }
        }
        if !cfg.client_cert.is_empty() {
            if Path::new(&cfg.client_cert).exists() {
                opts = opts.ssl_client_cert(Path::new(&cfg.client_cert));
            } else {
                opts = opts.ssl_client_cert_from_pem(cfg.client_cert.as_bytes().to_vec());
            }
        }
        if !cfg.client_key.is_empty() {
            if Path::new(&cfg.client_key).exists() {
                opts = opts.ssl_client_key(Path::new(&cfg.client_key));
            } else {
                opts = opts.ssl_client_key_from_pem(cfg.client_key.as_bytes().to_vec());
            }
        }
    }

    MySqlPoolOptions::new()
        .max_connections(MAX_CONN_PER_POOL)
        .min_connections(0)
        // 主动在 server 的 wait_timeout 之前回收连接，避免拿到已被 server 静默
        // 关闭的空闲连接去跑查询（典型症状：got 0 bytes at EOF）。
        // 30s 仍偏长——很多 MySQL server wait_timeout 配 60s 甚至更低，
        // 客户端等到 server 关了才被动发现总会有一次 EOF 漏到查询层。
        // 降到 15s 让 sqlx 主动回收，搭配 query() 层的 retry 兜底。
        .max_lifetime(Some(std::time::Duration::from_secs(1800)))
        .idle_timeout(Some(std::time::Duration::from_secs(15)))
        // 每次从池里取出连接前先 ping 一下，死连接会被丢弃并重连，绝不让 EOF 漏到查询层。
        .test_before_acquire(true)
        .after_connect(|conn, _info| {
            Box::pin(async move {
                // 抬高本会话的超时，尽量让服务端不要比客户端更早回收连接。
                // 受服务端 wait_timeout 上限约束；客户端仍靠上面的 max_lifetime 主动回收。
                sqlx::query("SET SESSION wait_timeout = 28800")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(AppError::Sqlx)
}

/// 将字符串形式的 ssl_mode 映射到 sqlx 枚举；无法识别或为空时回退到
/// `Preferred`（与 MySQL 客户端默认行为一致：能加密就加密，不能则直连）。
fn parse_ssl_mode(s: &str) -> MySqlSslMode {
    match s.to_ascii_lowercase().as_str() {
        "disabled" => MySqlSslMode::Disabled,
        "required" => MySqlSslMode::Required,
        "verify_ca" => MySqlSslMode::VerifyCa,
        "verify_identity" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

// --- SSH 隧道（#5 MVP） ----------------------------------------------------
// 全局隧道表：key = 与连接池相同的 pool_key。父进程随应用生命周期存在；
// 缓存池被 LRU 淘汰时一并 kill 子进程，避免残留 ssh -L 占用端口。
struct SshTunnel {
    child: Child,
    local_port: u16,
}
static SSH_TUNNELS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, SshTunnel>>> =
    OnceLock::new();

fn ssh_tunnels() -> &'static std::sync::Mutex<std::collections::HashMap<String, SshTunnel>> {
    SSH_TUNNELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 解析 SSH 私钥来源：
/// - 已是存在的文件路径 → 直接复用（ssh -i 只认路径）；
/// - 否则当作 PEM 文本，写入临时文件（权限 0600）后用其路径。
/// 这样前端「文件选择器读内容填框」与「手动填路径」两种用法都兼容。
fn resolve_ssh_key(key: &str) -> Option<PathBuf> {
    if key.is_empty() {
        return None;
    }
    let p = Path::new(key);
    if p.exists() && p.is_file() {
        return Some(p.to_path_buf());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("cq_ssh_key_{stamp}.pem"));
    if std::fs::write(&tmp, key.as_bytes()).is_ok() {
        #[cfg(unix)]
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        return Some(tmp);
    }
    None
}

/// 确保到目标 MySQL 的 SSH 本地转发已建立，返回本地监听端口。
/// 已存在且记录中的隧道直接复用；否则分配空闲本地端口、拉起 `ssh -L`。
fn ensure_ssh_tunnel(key: &str, cfg: &ConnectionConfig) -> Result<u16> {
    // 复用已存在的隧道（MVP 不校验进程是否已死，复用失败由 connect 报错暴露）。
    {
        let g = ssh_tunnels().lock().unwrap();
        if let Some(t) = g.get(key) {
            return Ok(t.local_port);
        }
    }

    // 分配一个空闲本地端口（bind 到 :0 后立刻释放，端口短暂空窗可接受）。
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Msg(format!("分配 SSH 隧道本地端口失败: {e}")))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| AppError::Msg(format!("分配 SSH 隧道本地端口失败: {e}")))?
        .port();
    drop(listener);

    let ssh_port = if cfg.ssh_port == 0 { 22 } else { cfg.ssh_port };
    let mut args: Vec<String> = vec![
        "-N".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "ExitOnForwardFailure=yes".to_string(),
        "-L".to_string(),
        format!("{local_port}:{}:{}", cfg.host, cfg.port),
        "-p".to_string(),
        ssh_port.to_string(),
    ];
    match cfg.ssh_auth_kind.as_str() {
        "key" => {
            if let Some(kp) = resolve_ssh_key(&cfg.ssh_private_key) {
                args.push("-i".to_string());
                args.push(kp.to_string_lossy().to_string());
            }
        }
        // 密码认证：ssh 无法非交互读密码，MVP 依赖 sshpass；缺失则明确报错。
        "password" => {
            args.push("-o".to_string());
            args.push("PreferredAuthentications=password".to_string());
            args.push("-o".to_string());
            args.push("PubkeyAuthentication=no".to_string());
        }
        _ => {} // agent / 默认：交给 SSH_AUTH_SOCK
    }
    args.push(format!("{}@{}", cfg.ssh_user, cfg.ssh_host));

    let child = if cfg.ssh_auth_kind == "password" && !cfg.ssh_password.is_empty() {
        // 用 sshpass 透传密码（注意：密码会出现在进程参数中，仅适合本地桌面工具）。
        let mut c = Command::new("sshpass");
        c.arg("-p").arg(&cfg.ssh_password).arg("ssh").args(&args);
        c.spawn().map_err(|e| {
            AppError::Msg(format!("无法启动 sshpass/ssh（请确认已安装 sshpass）: {e}"))
        })?
    } else {
        let mut c = Command::new("ssh");
        c.args(&args);
        c.spawn()
            .map_err(|e| AppError::Msg(format!("无法启动 ssh（请确认已安装 ssh 客户端）: {e}")))?
    };

    // 轮询本地端口直到转发就绪（有界等待，最长 3s），避免 ssh 尚未 bind 就连接。
    wait_for_local_port(local_port, Duration::from_secs(3))?;

    ssh_tunnels()
        .lock()
        .unwrap()
        .insert(key.to_string(), SshTunnel { child, local_port });
    Ok(local_port)
}

/// 有界等待本地端口进入监听状态；超时视为隧道建立失败。
fn wait_for_local_port(port: u16, timeout: Duration) -> Result<()> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(AppError::Msg(format!(
        "SSH 隧道本地端口 {port} 在超时内未就绪，请检查跳板机配置"
    )))
}

/// 从缓存取池：命中则更新 LRU 顺序并返回（clone 只是 Arc，零拷贝）；
/// 未命中则在锁外建连、再插入并 LRU 淘汰最久未用的池（解锁后才 close，避免持锁 await）。
async fn get_pool(cfg: &ConnectionConfig, database: &str) -> Result<MySqlPool> {
    let key = pool_key(cfg, database);
    // 先查（不持锁 await）
    let cached = {
        let mut g = pool_cache().lock().unwrap();
        if g.pools.contains_key(&key) {
            let cloned = g.pools.get(&key).unwrap().clone();
            if let Some(pos) = g.order.iter().position(|k| k == &key) {
                g.order.remove(pos);
            }
            g.order.push_back(key.clone());
            Some(cloned)
        } else {
            None
        }
    };
    if let Some(pool) = cached {
        return Ok(pool);
    }
    // 未命中：锁外建连接（避免持锁 await）
    let pool = connect_raw(cfg, database).await?;
    let mut to_close: Option<MySqlPool> = None;
    {
        let mut g = pool_cache().lock().unwrap();
        // double-check：可能并发已插入
        if g.pools.contains_key(&key) {
            let cloned = g.pools.get(&key).unwrap().clone();
            if let Some(pos) = g.order.iter().position(|k| k == &key) {
                g.order.remove(pos);
            }
            g.order.push_back(key.clone());
            // 已有则用已有的，新建的丢弃（drop 即可，不 close 缓存池）
            return Ok(cloned);
        }
        g.pools.insert(key.clone(), pool.clone());
        g.order.push_back(key);
        if g.pools.len() > MAX_CACHED_POOLS {
            if let Some(old_key) = g.order.pop_front() {
                to_close = g.pools.remove(&old_key);
                // 连接池被淘汰时一并 kill 其 SSH 隧道（若存在），避免残留进程占用端口。
                if let Some(mut t) = ssh_tunnels().lock().unwrap().remove(&old_key) {
                    let _ = t.child.kill();
                }
            }
        }
    } // 锁在此作用域结束自动释放
    if let Some(old) = to_close {
        old.close().await;
    }
    Ok(pool)
}

/// 默认库连接池（缓存）。连接配置里填了默认库就用它，否则连接不带当前库
/// （不再兜底 "mysql" 系统库）。
async fn connect_pool(cfg: &ConnectionConfig) -> Result<MySqlPool> {
    get_pool(cfg, &cfg.database).await
}

/// 指定库连接池（缓存），用于 schema 浏览任意 database。
async fn connect_pool_db(cfg: &ConnectionConfig, database: &str) -> Result<MySqlPool> {
    get_pool(cfg, database).await
}

/// Lazily fetch the schema (tables + columns) of a database, used to power SQL
/// autocomplete in the editor. `database` selects a specific schema; when None
/// the connection's default database is used. Bounded to one database — never
/// enumerates the whole server (ADR-006).
pub async fn schema(cfg: &ConnectionConfig, database: Option<&str>) -> Result<Schema> {
    let db = match database {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            if cfg.database.is_empty() {
                return Ok(Schema { tables: vec![] });
            }
            cfg.database.clone()
        }
    };
    with_stale_retry("mysql.schema", cfg, &db, |_attempt| async {
        let pool = connect_pool_db(cfg, &db).await?;
        // CAST every INFORMATION_SCHEMA text column to CHAR so sqlx decodes them as
        // VARCHAR instead of BINARY (binary charset would break String mapping).
        let rows = sqlx::query(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, \
                    CAST(DATA_TYPE AS CHAR) AS DATA_TYPE, CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY, \
                    CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE, CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 1000",
        )
        .bind(&db)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;
        let mut tables: Vec<TableInfo> = Vec::new();
        for row in rows {
            let tname: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
            let cname: String = row.try_get("COLUMN_NAME").map_err(AppError::Sqlx)?;
            let dtype: String = row.try_get("DATA_TYPE").map_err(AppError::Sqlx)?;
            let key: String = row.try_get("COLUMN_KEY").map_err(AppError::Sqlx)?;
            let nullable: String = row.try_get("IS_NULLABLE").map_err(AppError::Sqlx)?;
            let default: Option<String> = row.try_get("COLUMN_DEFAULT").ok().flatten();
            if let Some(last) = tables.last_mut() {
                if last.name == tname {
                    last.columns.push(ColumnInfo {
                        name: cname,
                        data_type: dtype,
                        key,
                        nullable,
                        default,
                        comment: None,
                    });
                    continue;
                }
            }
            tables.push(TableInfo {
                name: tname,
                columns: vec![ColumnInfo {
                    name: cname,
                    data_type: dtype,
                    key,
                    nullable,
                    default,
                    comment: None,
                }],
            });
        }
        Ok(Schema { tables })
    })
    .await
}

/// Lightweight connectivity check used by the connection form.
pub async fn test(cfg: &ConnectionConfig) -> Result<()> {
    with_stale_retry("mysql.test", cfg, &cfg.database, |_attempt| async {
        let pool = connect_pool(cfg).await?;
        sqlx::query("SELECT 1")
            .execute(&pool)
            .await
            .map_err(AppError::Sqlx)?;
        Ok(())
    })
    .await
}

/// Schema for a single database, returned to the frontend for editor autocomplete.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    /// PRI / UNI / MUL / "" — mirrors INFORMATION_SCHEMA.COLUMN_KEY.
    pub key: String,
    /// YES / NO.
    pub nullable: String,
    /// Raw default expression, or None when no default.
    pub default: Option<String>,
    /// Column comment from INFORMATION_SCHEMA (ADR-025+ completion enhancement).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    pub tables: Vec<TableInfo>,
}

/// A table or view in a database, used by the schema tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableMeta {
    pub name: String,
    /// true when this is a VIEW rather than a base TABLE.
    pub is_view: bool,
    /// Table comment from INFORMATION_SCHEMA.TABLES (e.g. Chinese description)
    #[serde(default)]
    pub comment: Option<String>,
}

fn extract_table_comment(row: &sqlx::mysql::MySqlRow) -> Option<String> {
    row.try_get::<String, _>("TABLE_COMMENT").ok().and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed.starts_with("InnoDB free:") {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// List non-system databases on the server (Navicat's "database" level).
pub async fn list_databases(cfg: &ConnectionConfig) -> Result<Vec<String>> {
    with_stale_retry(
        "mysql.list_databases",
        cfg,
        &cfg.database,
        |_attempt| async {
            // 只查 INFORMATION_SCHEMA，无需（也不应）连接 mysql 系统库——托管账号往往
            // 对 mysql 库无权限。走默认连接（空库或无库连接均可）。
            let pool = connect_pool(cfg).await?;
            // CAST SCHEMA_NAME to CHAR: INFORMATION_SCHEMA columns use a binary charset
            // and would decode as SQL type BINARY, incompatible with Rust String.
            let rows = sqlx::query(
                "SELECT CAST(SCHEMA_NAME AS CHAR) AS SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') \
             ORDER BY SCHEMA_NAME",
            )
            .fetch_all(&pool)
            .await
            .map_err(AppError::Sqlx)?;
            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                out.push(row.try_get("SCHEMA_NAME").map_err(AppError::Sqlx)?);
            }
            Ok(out)
        },
    )
    .await
}

/// List tables and views within a single database, ordered by name.
pub async fn list_tables(cfg: &ConnectionConfig, database: &str) -> Result<Vec<TableMeta>> {
    with_stale_retry("mysql.list_tables", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;
        // INFORMATION_SCHEMA text columns are defined with a binary charset in MySQL,
        // so sqlx reports them as SQL type BINARY and refuses to map them to String.
        // CAST to CHAR so they come back as VARCHAR (see list_tables/schema/describe_table).
        let rows = sqlx::query(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE, \
             CAST(TABLE_COMMENT AS CHAR) AS TABLE_COMMENT \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(database)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
            let ttype: String = row.try_get("TABLE_TYPE").map_err(AppError::Sqlx)?;
            let comment = extract_table_comment(&row);
            out.push(TableMeta {
                name,
                is_view: ttype.eq_ignore_ascii_case("VIEW"),
                comment,
            });
        }
        Ok(out)
    })
    .await
}

/// Search tables in a database by name prefix, bounded by `limit`. Powers the
/// editor's lazy autocomplete and the tree's folder filter — it never returns
/// the full 8000-table set, so the UI stays responsive on large schemas
/// (the old `list_tables` pulled every table, which froze the tree at scale).
/// Classic Levenshtein edit distance — powers the fuzzy table-name search
/// (`~xxx~` mode). One/two-char typos (k_tsk → k_task) survive this.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = if ca == cb {
                prev[j]
            } else {
                1 + prev[j].min(prev[j + 1]).min(cur[j])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

pub async fn search_tables(
    cfg: &ConnectionConfig,
    database: &str,
    like: Option<&str>,
    limit: usize,
) -> Result<Vec<TableMeta>> {
    with_stale_retry("mysql.search_tables", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;

        // FUZZY mode: `~k_tsk~` — edit-distance (≤2) match against every
        // table, sorted by distance. Catches typos the prefix/substring
        // passes can't (k_tsk → k_task). Pulls the full name list (a few
        // thousand rows is fine — INFORMATION_SCHEMA scan + in-Rust DP).
        if let Some(like) = like {
            if like.starts_with('~') && like.ends_with('~') && like.len() > 2 {
                let needle = like.trim_matches('~');
                let rows = sqlx::query(
                    "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE, \
                     CAST(TABLE_COMMENT AS CHAR) AS TABLE_COMMENT \
                     FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?",
                )
                .bind(database)
                .fetch_all(&pool)
                .await
                .map_err(AppError::Sqlx)?;
                let mut scored: Vec<(usize, TableMeta)> = Vec::new();
                for row in rows {
                    let name: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
                    // Length gate: a table 3+ chars longer/shorter can't be
                    // within 2 edits — skip the DP for it.
                    if name.len().abs_diff(needle.len()) > 3 {
                        continue;
                    }
                    let d = levenshtein(&name, needle);
                    if d <= 2 {
                        let ttype: String = row.try_get("TABLE_TYPE").map_err(AppError::Sqlx)?;
                        let comment = extract_table_comment(&row);
                        scored.push((d, TableMeta {
                            name,
                            is_view: ttype.eq_ignore_ascii_case("VIEW"),
                            comment,
                        }));
                    }
                }
                scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
                scored.truncate(limit);
                return Ok(scored.into_iter().map(|(_, t)| t).collect());
            }
        }

        let mut sql = String::from(
            "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE, \
             CAST(TABLE_COMMENT AS CHAR) AS TABLE_COMMENT \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = ?",
        );
        let mut binds: Vec<String> = Vec::new();
        if let Some(like) = like {
            if !like.is_empty() {
                // `*k*` = SUBSTRING match (`%k%`); anything else = prefix match
                // (`k%`). Either way the user's wildcards are escaped so a
                // literal `%` / `_` is matched literally, not as a wildcard.
                let (pre, post) = if like.starts_with('*') && like.ends_with('*') && like.len() > 2 {
                    ("%", "%")
                } else {
                    ("", "%")
                };
                sql.push_str(" AND TABLE_NAME LIKE ? ESCAPE '\\\\'");
                let inner = like.trim_matches('*');
                let pat = format!(
                    "{}{}{}",
                    pre,
                    inner.replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_"),
                    post
                );
                binds.push(pat);
            }
        }
        sql.push_str(&format!(" ORDER BY TABLE_NAME LIMIT {}", limit));
        let mut q = sqlx::query(&sql).bind(database);
        for b in &binds {
            q = q.bind(b.clone());
        }
        let rows = q.fetch_all(&pool).await.map_err(AppError::Sqlx)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
            let ttype: String = row.try_get("TABLE_TYPE").map_err(AppError::Sqlx)?;
            let comment = extract_table_comment(&row);
            out.push(TableMeta {
                name,
                is_view: ttype.eq_ignore_ascii_case("VIEW"),
                comment,
            });
        }
        Ok(out)
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogSearchResult {
    pub db: String,
    pub table: Option<String>,
    pub is_view: bool,
    pub comment: Option<String>,
}

/// Search across ALL databases in a connection instance for matching databases,
/// tables, and table comments. Extremely fast (usually 20-50ms) using single-pass
/// queries against INFORMATION_SCHEMA without requiring connections to be expanded.
pub async fn search_catalog(
    cfg: &ConnectionConfig,
    query: &str,
    limit: usize,
) -> Result<Vec<CatalogSearchResult>> {
    with_stale_retry("mysql.search_catalog", cfg, &cfg.database, |_attempt| async {
        let pool = connect_pool(cfg).await?;
        let q = format!("%{}%", query.trim());
        let limit = limit.min(100).max(1);

        let mut results = Vec::new();

        // 1. Search matching database names
        let db_rows = sqlx::query(
            "SELECT CAST(SCHEMA_NAME AS CHAR) AS SCHEMA_NAME \
             FROM INFORMATION_SCHEMA.SCHEMATA \
             WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') \
               AND SCHEMA_NAME LIKE ? \
             ORDER BY SCHEMA_NAME LIMIT 20",
        )
        .bind(&q)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;

        for row in db_rows {
            let db: String = row.try_get("SCHEMA_NAME").map_err(AppError::Sqlx)?;
            results.push(CatalogSearchResult {
                db,
                table: None,
                is_view: false,
                comment: None,
            });
        }

        // 2. Search matching tables / views / comments across all non-system databases
        let tbl_rows = sqlx::query(
            "SELECT CAST(TABLE_SCHEMA AS CHAR) AS TABLE_SCHEMA, \
                    CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, \
                    CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE, \
                    CAST(TABLE_COMMENT AS CHAR) AS TABLE_COMMENT \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
               AND (TABLE_NAME LIKE ? OR TABLE_COMMENT LIKE ?) \
             ORDER BY TABLE_NAME LIMIT ?",
        )
        .bind(&q)
        .bind(&q)
        .bind(limit as i64)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;

        for row in tbl_rows {
            let db: String = row.try_get("TABLE_SCHEMA").map_err(AppError::Sqlx)?;
            let table: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
            let ttype: String = row.try_get("TABLE_TYPE").map_err(AppError::Sqlx)?;
            let comment: Option<String> = row
                .try_get::<String, _>("TABLE_COMMENT")
                .ok()
                .filter(|s| !s.trim().is_empty());

            results.push(CatalogSearchResult {
                db,
                table: Some(table),
                is_view: ttype.eq_ignore_ascii_case("VIEW"),
                comment,
            });
        }

        Ok(results)
    })
    .await
}

/// List columns of a single table/view, including key/nullable/default.
pub async fn list_columns(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>> {
    with_stale_retry("mysql.list_columns", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;
        // CAST every INFORMATION_SCHEMA text column to CHAR: on some servers
        // (e.g. older MySQL behind rdsproxy) they are declared with a binary
        // charset and sqlx decodes them as SQL BLOB, which fails try_get::<String>
        // and made column completion return an error every time.
        let rows = sqlx::query(
            "SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, \
                    CAST(DATA_TYPE AS CHAR) AS DATA_TYPE, \
                    CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY, \
                    CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE, \
                    CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT, \
                    CAST(COLUMN_COMMENT AS CHAR) AS COLUMN_COMMENT \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let name: String = row.try_get("COLUMN_NAME").map_err(AppError::Sqlx)?;
            let data_type: String = row.try_get("DATA_TYPE").map_err(AppError::Sqlx)?;
            let key: String = row.try_get("COLUMN_KEY").map_err(AppError::Sqlx)?;
            let nullable: String = row.try_get("IS_NULLABLE").map_err(AppError::Sqlx)?;
            let default: Option<String> = row.try_get("COLUMN_DEFAULT").ok().flatten();
            let comment_raw: Option<String> = row.try_get("COLUMN_COMMENT").ok().flatten();
            let comment = comment_raw
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty());
            out.push(ColumnInfo {
                name,
                data_type,
                key,
                nullable,
                default,
                comment,
            });
        }
        Ok(out)
    })
    .await
}

/// Read-only paginated browse of a table:
/// `SELECT * FROM \`db\`.\`tbl\` LIMIT ? OFFSET ?`, plus a `SELECT COUNT(*)`
/// for the total row count so the UI can render a pager. `page` is 0-based;
/// `page_size` is clamped to MAX_PAGE_SIZE. Identifiers are quoted (backticks
/// stripped, then wrapped) so a hostile name can't break out — and legitimate
/// names with spaces/special chars are preserved (unlike a sanitize that
/// would have dropped them and produced "table not found").
pub async fn browse(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
    page: usize,
    page_size: usize,
) -> Result<QueryResult> {
    with_stale_retry("mysql.browse", cfg, database, |_attempt| async {
        let page_size = page_size.min(MAX_PAGE_SIZE).max(1);
        let offset = page.saturating_mul(page_size);
        let pool = connect_pool_db(cfg, database).await?;

        // Fully-qualified table reference: `db`.`tbl` — a DOT, not a space. A space
        // would make MySQL treat `db` as a table name in the current schema, which
        // produced "Table 'kf_ai.kf_ai' doesn't exist" (the db was misread as a
        // table, the real table name became an alias).
        let table_ref = qualified_table(database, table);

        // Primary-key columns so the UI can locate a row for writes. Careful: a
        // table with no primary key can't be safely written back (no stable row
        // identity), so we surface the empty list and the UI disables editing.
        // CAST COLUMN_NAME to CHAR: INFORMATION_SCHEMA text columns are binary-charset.
        let pk_rows = sqlx::query(
            "SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_KEY = 'PRI' \
             ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;
        let primary_keys: Vec<String> = pk_rows
            .iter()
            .map(|r| r.try_get::<String, _>("COLUMN_NAME").unwrap_or_default())
            .collect();

        let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", table_ref))
            .fetch_one(&pool)
            .await
            .map_err(AppError::Sqlx)?;

        let sql = format!("SELECT * FROM {} LIMIT ? OFFSET ?", table_ref);
        let mut stream = sqlx::query(&sql)
            .bind(page_size as u64)
            .bind(offset as u64)
            .fetch(&pool);
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<String>> = Vec::new();
        while let Some(row) = stream.try_next().await.map_err(AppError::Sqlx)? {
            if columns.is_empty() {
                for c in row.columns() {
                    columns.push(c.name().to_string());
                }
            }
            rows.push(decode_row(&row).await);
        }
        Ok(QueryResult {
            columns,
            rows,
            truncated: false,
            total: Some(total.max(0) as usize),
            primary_keys,
            affected: None,
            last_insert_id: None,
        })
    })
    .await
}

/// Write back a single row's edited cells. All changes for one row are folded
/// into ONE parameterized `UPDATE` — `SET` carries the new values and `WHERE`
/// uses the ORIGINAL primary-key values (the row snapshot). This matters when
/// the primary key itself was edited: MySQL locates the row by its old PK, then
/// applies the new PK in the same statement. Values are bound as parameters, so
/// injection is impossible; an empty change-set is a no-op. Runs inside a
/// transaction so a mid-batch failure rolls back cleanly.
///
/// Intentionally out of scope (see ADR-018): INSERT/DELETE (new/removed rows),
/// NULL literals, BLOB/binary columns, and optimistic-lock conflict detection.
pub async fn apply_edit(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
    pk: Vec<(String, String)>,
    set: Vec<(String, String)>,
) -> Result<()> {
    if set.is_empty() {
        return Ok(());
    }
    // Wrap the whole body (tx + execute + commit) in stale-retry. If begin()
    // or execute() hits EOF, sqlx auto-rolls back the half-started tx on
    // drop and the retry re-runs against a freshly-acquired connection.
    with_stale_retry("mysql.apply_edit", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;
        let table_ref = qualified_table(database, table);

        let mut sql = format!("UPDATE {} SET ", table_ref);
        for (i, (col, _)) in set.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(&format!("{} = ?", quote_ident(col)));
        }
        sql.push_str(" WHERE ");
        for (i, (col, _)) in pk.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&format!("{} = ?", quote_ident(col)));
        }

        let mut tx = pool.begin().await.map_err(AppError::Sqlx)?;
        let mut q = sqlx::query(&sql);
        for (_, v) in &set {
            q = q.bind(v.clone());
        }
        for (_, v) in &pk {
            q = q.bind(v.clone());
        }
        q.execute(&mut *tx).await.map_err(AppError::Sqlx)?;
        tx.commit().await.map_err(AppError::Sqlx)?;
        Ok(())
    })
    .await
}

/// Insert a new row. Only the columns the user explicitly typed are included
/// in the INSERT — omitted columns fall back to DB defaults (AUTO_INCREMENT,
/// DEFAULT, NULL). Values are bound as parameters. Runs in a transaction so a
/// failure rolls back cleanly (though a single-row INSERT is atomic anyway,
/// the tx keeps the pattern uniform with `apply_edit`/`delete_row`).
pub async fn insert_row(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
    values: Vec<(String, String)>,
) -> Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    with_stale_retry("mysql.insert_row", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;
        let table_ref = qualified_table(database, table);

        let cols: Vec<String> = values.iter().map(|(c, _)| quote_ident(c)).collect();
        let placeholders: Vec<&str> = values.iter().map(|_| "?").collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table_ref,
            cols.join(", "),
            placeholders.join(", "),
        );

        let mut tx = pool.begin().await.map_err(AppError::Sqlx)?;
        let mut q = sqlx::query(&sql);
        for (_, v) in &values {
            q = q.bind(v.clone());
        }
        q.execute(&mut *tx).await.map_err(AppError::Sqlx)?;
        tx.commit().await.map_err(AppError::Sqlx)?;
        Ok(())
    })
    .await
}

/// Delete a single row by its primary-key snapshot. The `pk` vector carries
/// the ORIGINAL column/value pairs (same model as `apply_edit`). The generated
/// DELETE uses `WHERE pk1 = ? AND pk2 = ? …` with bound parameters. Empty `pk`
/// is rejected — deleting without a stable row identity is unsafe.
pub async fn delete_row(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
    pk: Vec<(String, String)>,
) -> Result<()> {
    if pk.is_empty() {
        return Err(AppError::Msg(
            "无法删除：该表没有主键，无法安全定位行".into(),
        ));
    }
    with_stale_retry("mysql.delete_row", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;
        let table_ref = qualified_table(database, table);

        let mut sql = format!("DELETE FROM {} WHERE ", table_ref);
        for (i, (col, _)) in pk.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&format!("{} = ?", quote_ident(col)));
        }

        let mut tx = pool.begin().await.map_err(AppError::Sqlx)?;
        let mut q = sqlx::query(&sql);
        for (_, v) in &pk {
            q = q.bind(v.clone());
        }
        q.execute(&mut *tx).await.map_err(AppError::Sqlx)?;
        tx.commit().await.map_err(AppError::Sqlx)?;
        Ok(())
    })
    .await
}

/// A column's full structure detail — richer than `ColumnInfo` (which only
/// has the base `DATA_TYPE`). `column_type` is the full type string like
/// `varchar(255)` or `int unsigned`, and `extra` captures `auto_increment`,
/// `on update CURRENT_TIMESTAMP`, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDetail {
    pub name: String,
    /// Full type string, e.g. `varchar(255)`, `int unsigned`, `decimal(10,2)`.
    pub column_type: String,
    pub nullable: bool,
    /// PRI / UNI / MUL / "" — mirrors INFORMATION_SCHEMA.COLUMN_KEY.
    pub key: String,
    /// Raw default expression, or None when no default.
    pub default: Option<String>,
    /// `auto_increment`, `on update CURRENT_TIMESTAMP`, `""`, etc.
    pub extra: String,
    /// Column comment from INFORMATION_SCHEMA.COLUMN_COMMENT
    pub comment: Option<String>,
}

/// One index entry — a single (index, column) pair. A multi-column index
/// produces multiple entries with increasing `seq`. The frontend groups by
/// `name` to render a human-friendly index list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub column: String,
    pub unique: bool,
    /// 1-based position within the index.
    pub seq: u32,
}

/// Full table structure: columns, indexes, and the CREATE TABLE DDL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStructure {
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    /// The `SHOW CREATE TABLE` output, verbatim.
    pub create_sql: String,
    /// Table comment from INFORMATION_SCHEMA.TABLES.TABLE_COMMENT
    pub table_comment: Option<String>,
}

/// Fetch the full structure of a table: column details (with full type and
/// extra), index list, and the CREATE TABLE DDL. This is the backend for the
/// "表结构" view — distinct from `list_columns` (used by the tree/autocomplete,
/// which only needs the base data type).
pub async fn describe_table(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
) -> Result<TableStructure> {
    with_stale_retry("mysql.describe_table", cfg, database, |_attempt| async {
        let pool = connect_pool_db(cfg, database).await?;

        // 1. Column details — use COLUMN_TYPE (full), EXTRA and COLUMN_COMMENT which list_columns
        //    doesn't select.
        // CAST every INFORMATION_SCHEMA text column to CHAR so sqlx decodes them as
        // VARCHAR instead of BINARY (binary charset would break String mapping).
        let col_rows = sqlx::query(
            "SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, CAST(COLUMN_TYPE AS CHAR) AS COLUMN_TYPE, \
                    CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE, CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY, \
                    CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT, CAST(EXTRA AS CHAR) AS EXTRA, \
                    CAST(COLUMN_COMMENT AS CHAR) AS COLUMN_COMMENT \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool)
        .await
        .map_err(AppError::Sqlx)?;
        let mut columns = Vec::with_capacity(col_rows.len());
        for row in col_rows {
            let name: String = row.try_get("COLUMN_NAME").map_err(AppError::Sqlx)?;
            let column_type: String = row.try_get("COLUMN_TYPE").map_err(AppError::Sqlx)?;
            let nullable_str: String = row.try_get("IS_NULLABLE").map_err(AppError::Sqlx)?;
            let key: String = row.try_get("COLUMN_KEY").map_err(AppError::Sqlx)?;
            let default: Option<String> = row.try_get("COLUMN_DEFAULT").ok().flatten();
            let extra: String = row.try_get("EXTRA").map_err(AppError::Sqlx)?;
            let comment: Option<String> = row
                .try_get::<String, _>("COLUMN_COMMENT")
                .ok()
                .filter(|s| !s.trim().is_empty());
            columns.push(ColumnDetail {
                name,
                column_type,
                nullable: nullable_str.eq_ignore_ascii_case("YES"),
                key,
                default,
                extra,
                comment,
            });
        }

        // 2. Indexes — SHOW INDEX returns one row per (index, column). Grouping is
        //    left to the frontend; the raw entries preserve order and uniqueness.
        let idx_sql = format!("SHOW INDEX FROM {}", qualified_table(database, table));
        let idx_rows = sqlx::query(&idx_sql)
            .fetch_all(&pool)
            .await
            .map_err(AppError::Sqlx)?;
        let mut indexes = Vec::with_capacity(idx_rows.len());
        for row in idx_rows {
            let name: String = row.try_get("Key_name").map_err(AppError::Sqlx)?;
            let non_unique: i64 = row.try_get("Non_unique").map_err(AppError::Sqlx)?;
            let seq: i64 = row.try_get("Seq_in_index").map_err(AppError::Sqlx)?;
            let column: String = row.try_get("Column_name").map_err(AppError::Sqlx)?;
            indexes.push(IndexInfo {
                name,
                column,
                unique: non_unique == 0,
                seq: seq.max(1) as u32,
            });
        }

        // 3. DDL — SHOW CREATE TABLE returns two columns: Table, Create Table.
        let ddl_sql = format!("SHOW CREATE TABLE {}", qualified_table(database, table));
        let ddl_row = sqlx::query(&ddl_sql)
            .fetch_one(&pool)
            .await
            .map_err(AppError::Sqlx)?;
        let create_sql: String = ddl_row
            .try_get::<String, _>(1)
            .map_err(AppError::Sqlx)?;

        // 4. Table Comment from INFORMATION_SCHEMA.TABLES
        let table_comment: Option<String> = sqlx::query_scalar(
            "SELECT CAST(TABLE_COMMENT AS CHAR) FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        )
        .bind(database)
        .bind(table)
        .fetch_optional(&pool)
        .await
        .unwrap_or(None)
        .filter(|s: &String| !s.trim().is_empty());

        Ok(TableStructure {
            columns,
            indexes,
            create_sql,
            table_comment,
        })
    })
    .await
}

/// A foreign-key relationship discovered from INFORMATION_SCHEMA. Each entry
/// represents one column referencing another table's column. A composite FK
/// produces multiple entries sharing the same `constraint_name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    /// The FK constraint name (e.g. `fk_orders_user`).
    pub constraint_name: String,
    /// The table that owns the FK.
    pub table_name: String,
    /// The column in `table_name` that references the parent.
    pub column_name: String,
    /// The referenced (parent) table.
    pub referenced_table: String,
    /// The referenced (parent) column.
    pub referenced_column: String,
}

/// List all foreign-key relationships in a database. Queries
/// INFORMATION_SCHEMA.KEY_COLUMN_USAGE where REFERENCED_TABLE_NAME is not NULL
/// — these are the actual FK constraints, not just logical relationships.
/// Powers the ER / table-relationship view (ADR-021).
pub async fn list_relationships(
    cfg: &ConnectionConfig,
    database: &str,
) -> Result<Vec<ForeignKeyInfo>> {
    with_stale_retry(
        "mysql.list_relationships",
        cfg,
        database,
        |_attempt| async {
            let pool = connect_pool_db(cfg, database).await?;
            // CAST every INFORMATION_SCHEMA text column to CHAR: they use a binary
            // charset and would decode as SQL type BINARY, incompatible with Rust String.
            let rows = sqlx::query(
                "SELECT CAST(CONSTRAINT_NAME AS CHAR) AS CONSTRAINT_NAME, \
                    CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, \
                    CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, \
                    CAST(REFERENCED_TABLE_NAME AS CHAR) AS REFERENCED_TABLE_NAME, \
                    CAST(REFERENCED_COLUMN_NAME AS CHAR) AS REFERENCED_COLUMN_NAME \
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION",
            )
            .bind(database)
            .fetch_all(&pool)
            .await
            .map_err(AppError::Sqlx)?;
            let mut out = Vec::with_capacity(rows.len());
            for row in rows {
                let constraint_name: String =
                    row.try_get("CONSTRAINT_NAME").map_err(AppError::Sqlx)?;
                let table_name: String = row.try_get("TABLE_NAME").map_err(AppError::Sqlx)?;
                let column_name: String = row.try_get("COLUMN_NAME").map_err(AppError::Sqlx)?;
                let referenced_table: String = row
                    .try_get("REFERENCED_TABLE_NAME")
                    .map_err(AppError::Sqlx)?;
                let referenced_column: String = row
                    .try_get("REFERENCED_COLUMN_NAME")
                    .map_err(AppError::Sqlx)?;
                out.push(ForeignKeyInfo {
                    constraint_name,
                    table_name,
                    column_name,
                    referenced_table,
                    referenced_column,
                });
            }
            Ok(out)
        },
    )
    .await
}

/// Quote a SQL identifier safely: strip any backtick (so a name containing one
/// can't escape the quotes) then wrap in backticks. Preserves spaces and other
/// legal characters, unlike an alphanumeric sanitizer.
pub fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', ""))
}

/// Fully-qualified table reference: `db`.`tbl`, joined by a DOT. A space here
/// is a real bug — it makes MySQL read the database as a table name (see the
/// "Table 'kf_ai.kf_ai' doesn't exist" regression). Kept as its own function so
/// it can be unit-tested without a live database.
fn qualified_table(database: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(table))
}

// --- EXPLAIN 执行计划可视化（#6） -------------------------------------------
//
// MySQL 8.0.18+ 支持 `EXPLAIN FORMAT=JSON`，返回一棵已经结构化的执行计划树
// （query_block → table / nested_loop / materialized_from_subquery）。我们递归
// 解析为 `ExplainNode` 树，前端渲染成「节点 = 表/索引、颜色 = 扫描类型」的树视图
// 与按 cost 横向排布的火焰图。老版本（或返回字符串）时回退到经典表格 EXPLAIN，
// 原样返回文本给前端展示。

/// 执行计划树的一个节点：对应一张被访问的表（或其上的嵌套子查询）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainNode {
    /// 表名；子查询节点为 "SUBQUERY" / "DERIVED" 等。
    pub name: String,
    /// 访问类型：ALL / index / range / ref / eq_ref / const / system。
    pub access_type: String,
    /// 预计扫描行数（rows_examined_per_scan）。
    pub rows: u64,
    /// 该节点代价（cost_info.query_cost）。
    pub cost: f64,
    /// 实际使用的索引（key）。
    pub key: String,
    /// 候选索引列表（possible_keys）。
    pub possible_keys: Vec<String>,
    /// 附加信息（attached_condition 等）。
    pub extra: String,
    /// 嵌套访问（JOIN / 子查询）。
    pub children: Vec<ExplainNode>,
}

/// EXPLAIN 可视化结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainVisual {
    /// "json" = 已解析为树；"legacy" = 解析失败，仅原样文本。
    pub format: String,
    /// JSON 模式下的解析树（可能为多个根，通常一个）。
    pub nodes: Vec<ExplainNode>,
    /// 原始文本（JSON 模式为美化后的 JSON；legacy 为表格文本），前端可同时展示。
    pub raw: Option<String>,
}

/// 执行一条 SELECT 的 EXPLAIN 并可视化为树。非 SELECT 或解析失败时回退 legacy。
pub async fn explain_visual(
    cfg: &ConnectionConfig,
    query: &str,
    database: Option<&str>,
) -> Result<ExplainVisual> {
    let key_db = match database {
        Some(d) if !d.is_empty() => d,
        _ => cfg.database.as_str(),
    };
    with_stale_retry("mysql.explain_visual", cfg, key_db, |_attempt| async {
        let pool = match database {
            Some(db) if !db.is_empty() => connect_pool_db(cfg, db).await?,
            _ => connect_pool(cfg).await?,
        };

        // 去掉用户可能已写的 EXPLAIN / FORMAT=JSON 前缀，统一用 JSON 形态。
        let inner = strip_explain_prefix(query);
        if !is_select_query(&inner) {
            return legacy_explain(&pool, &inner).await;
        }

        let json_sql = format!("EXPLAIN FORMAT=JSON {}", inner);
        let row = sqlx::query(&json_sql)
            .fetch_optional(&pool)
            .await
            .map_err(AppError::Sqlx)?;

        match row {
            Some(r) => {
                // FORMAT=JSON 返回单列 "EXPLAIN"（MySQL 8）或 "QUERY PLAN"（MariaDB）。
                let text: String = match r.try_get::<Option<String>, _>(0).ok().flatten() {
                    Some(t) => t,
                    None => r
                        .try_get::<String, _>(0)
                        .unwrap_or_else(|_| "{}".to_string()),
                };
                match parse_explain_json(&text) {
                    Some(nodes) => Ok(ExplainVisual {
                        format: "json".into(),
                        nodes,
                        raw: Some(text),
                    }),
                    None => Ok(legacy_explain(&pool, &inner).await?),
                }
            }
            // 该 MySQL 版本不支持 FORMAT=JSON → 回退经典表格。
            None => Ok(legacy_explain(&pool, &inner).await?),
        }
    })
    .await
}

/// 去掉 SQL 开头可能的 `EXPLAIN`、`EXPLAIN FORMAT=JSON` / `FORMAT=JSON` 前缀，
/// 仅保留真正的语句主体。
fn strip_explain_prefix(sql: &str) -> String {
    let re = regex::Regex::new(r"(?i)^\s*EXPLAIN\s+(FORMAT\s*=\s*JSON\s+)?").unwrap();
    let s = re.replace(sql, "").to_string();
    let re2 = regex::Regex::new(r"(?i)^\s*FORMAT\s*=\s*JSON\s+").unwrap();
    re2.replace(&s, "").to_string()
}

async fn legacy_explain(pool: &MySqlPool, inner: &str) -> Result<ExplainVisual> {
    let sql = format!("EXPLAIN {}", inner);
    let rows: Vec<sqlx::mysql::MySqlRow> = sqlx::query(&sql)
        .fetch_all(pool)
        .await
        .map_err(AppError::Sqlx)?;
    let mut out = String::new();
    if let Some(first) = rows.first() {
        let cols: Vec<String> = first
            .columns()
            .iter()
            .map(|c: &sqlx::mysql::MySqlColumn| c.name().to_string())
            .collect();
        out.push_str(&cols.join("\t"));
        out.push('\n');
    }
    for row in &rows {
        let mut vals = Vec::new();
        for c in row.columns() {
            let v: String = row
                .try_get::<Option<String>, _>(c.ordinal())
                .ok()
                .flatten()
                .unwrap_or_else(|| "NULL".to_string());
            vals.push(v);
        }
        out.push_str(&vals.join("\t"));
        out.push('\n');
    }
    Ok(ExplainVisual {
        format: "legacy".into(),
        nodes: vec![],
        raw: Some(out),
    })
}

/// 解析 `EXPLAIN FORMAT=JSON` 的输出文本为节点树。
fn parse_explain_json(text: &str) -> Option<Vec<ExplainNode>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let qb = v.get("query_block")?;
    Some(vec![parse_query_block(qb)])
}

/// 解析一个 query_block：若直接含 `table` 则它就是根节点；否则聚合
/// `nested_loop` 与子查询为 children。
fn parse_query_block(qb: &serde_json::Value) -> ExplainNode {
    if let Some(t) = qb.get("table") {
        return parse_table(t);
    }
    let mut children = Vec::new();
    if let Some(nl) = qb.get("nested_loop").and_then(|x| x.as_array()) {
        for item in nl {
            if let Some(tt) = item.get("table") {
                children.push(parse_table(tt));
            } else if let Some(sub) = item.get("materialized_from_subquery") {
                if let Some(iq) = sub.get("query_block") {
                    children.push(parse_query_block(iq));
                }
            }
        }
    }
    if let Some(sub) = qb.get("materialized_from_subquery") {
        if let Some(iq) = sub.get("query_block") {
            children.push(parse_query_block(iq));
        }
    }
    if let Some(sub) = qb.get("query_expression") {
        if let Some(iq) = sub.get("query_block") {
            children.push(parse_query_block(iq));
        }
    }
    ExplainNode {
        name: "QUERY BLOCK".into(),
        access_type: String::new(),
        rows: 0,
        cost: qb
            .get("cost_info")
            .and_then(|c| c.get("query_cost"))
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0),
        key: String::new(),
        possible_keys: vec![],
        extra: String::new(),
        children,
    }
}

fn parse_table(t: &serde_json::Value) -> ExplainNode {
    let name = t
        .get("table_name")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_string();
    let access_type = t
        .get("access_type")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let rows = t
        .get("rows_examined_per_scan")
        .and_then(|x| x.as_u64())
        .or_else(|| t.get("rows_produced_per_join").and_then(|x| x.as_u64()))
        .unwrap_or(0);
    let cost = t
        .get("cost_info")
        .and_then(|c| c.get("query_cost"))
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let key = t
        .get("key")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let possible_keys = t
        .get("possible_keys")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let extra = t
        .get("attached_condition")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let mut children = Vec::new();
    if let Some(nl) = t.get("nested_loop").and_then(|x| x.as_array()) {
        for item in nl {
            if let Some(tt) = item.get("table") {
                children.push(parse_table(tt));
            } else if let Some(sub) = item.get("materialized_from_subquery") {
                if let Some(iq) = sub.get("query_block") {
                    children.push(parse_query_block(iq));
                }
            }
        }
    }
    if let Some(sub) = t.get("materialized_from_subquery") {
        if let Some(iq) = sub.get("query_block") {
            children.push(parse_query_block(iq));
        }
    }
    ExplainNode {
        name,
        access_type,
        rows,
        cost,
        key,
        possible_keys,
        extra,
        children,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：不给 invalidate_pool_cache 写单元测试——构造池对象（即使
    // connect_lazy_with 不建连）在测试进程里会死锁挂死整个测试套件，
    // 已实测确认。该函数仅 8 行纯 map 操作，靠 code review 保证。

    /// utf8mb4_bin 的 VARCHAR 在协议里带 BINARY 标志，sqlx 按 Vec<u8> 解码，
    /// 但载荷是明文 —— 必须显示原文而不是 0x hex（回归：model_name 列）。
    #[test]
    fn binary_column_with_plain_text_shows_text() {
        assert_eq!(bytes_to_display(b"aliyun:glm-5.1"), "aliyun:glm-5.1");
        // 中文、含制表换行的文本同样直出
        assert_eq!(
            bytes_to_display("模型名\n\taliyun:glm-5.1".as_bytes()),
            "模型名\n\taliyun:glm-5.1"
        );
        // 空值显示为空单元格，而不是 "0x"
        assert_eq!(bytes_to_display(b""), "");
    }

    /// 真二进制（非 UTF-8、控制字符）保持 0x hex 兜底。
    #[test]
    fn binary_column_with_real_bytes_stays_hex() {
        assert_eq!(bytes_to_display(&[0x61, 0x6c, 0x00, 0x69]), "0x616c0069");
        assert!(bytes_to_display(&[0xff, 0xfe, 0xfd]).starts_with("0x"));
        // NUL 夹在明文中间也算二进制，避免把损坏数据当好数据展示
        assert_eq!(bytes_to_display(b"ab\x00cd"), "0x6162006364");
    }

    #[test]
    fn to_csv_quotes_special_fields() {
        let r = QueryResult {
            columns: vec!["id".into(), "name".into()],
            rows: vec![
                vec!["1".into(), "a,b".into()],
                vec!["2".into(), "he said \"hi\"".into()],
            ],
            truncated: false,
            total: None,
            primary_keys: vec![],
            affected: None,
            last_insert_id: None,
        };
        let csv = to_csv(&r);
        assert!(csv.contains("\"a,b\""));
        assert!(csv.contains("\"he said \"\"hi\"\"\""));
        assert!(csv.starts_with("id,name\n"));
    }

    #[test]
    fn qualified_table_uses_dot_not_space() {
        // Regression: `db tbl` (space) made MySQL read the db as a table name,
        // producing "Table 'kf_ai.kf_ai' doesn't exist". Must be `db`.`tbl`.
        assert_eq!(qualified_table("kf_ai", "orders"), "`kf_ai`.`orders`");
        assert_eq!(qualified_table("db", "t"), "`db`.`t`");
    }

    #[test]
    fn quote_ident_strips_backticks() {
        assert_eq!(quote_ident("a`b"), "`ab`");
        assert_eq!(quote_ident("weird name"), "`weird name`");
    }

    #[test]
    fn is_select_query_recognises_select_only() {
        assert!(is_select_query("SELECT * FROM t"));
        // Regression: formatted SQL has a NEWLINE after SELECT — used to miss
        // is_select_query, falling back to plain unpaged query (total=None, no pager).
        assert!(is_select_query(
            "SELECT\n    org.name AS 公司\nFROM k_task t"
        ));
        assert!(is_select_query("  select id from t where x = 1  "));
        assert!(is_select_query("-- comment\nSELECT * FROM t"));
        assert!(is_select_query("SELECT * FROM t WHERE msg = 'a;b'"));
        assert!(!is_select_query("SHOW CREATE TABLE t"));
        assert!(!is_select_query("EXPLAIN SELECT * FROM t"));
        assert!(!is_select_query("INSERT INTO t VALUES (1)"));
        assert!(!is_select_query("SELECT * FROM t; SHOW CREATE TABLE t"));
        assert!(is_select_query("SELECT * FROM t;"));
        assert!(!is_select_query("SELECT * FROM t; SHOW CREATE TABLE t"));
    }

    #[test]
    fn is_read_query_classifies_reads_vs_writes() {
        // Reads: result-set / state statements keep the fetch path.
        assert!(is_read_query("SELECT * FROM t"));
        // Regression: formatted SQL has a NEWLINE after SELECT, not a space —
        // used to be misrouted to the write path ("写操作执行成功" on a SELECT).
        assert!(is_read_query("SELECT\n    org.name AS 公司\nFROM k_task t"));
        assert!(is_read_query("-- c\nSELECT id FROM t"));
        assert!(is_read_query("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(is_read_query("SHOW TABLES"));
        assert!(is_read_query("SHOW CREATE TABLE t;"));
        assert!(is_read_query("EXPLAIN SELECT * FROM t"));
        assert!(is_read_query("DESC t"));
        assert!(is_read_query("DESCRIBE t"));
        assert!(is_read_query("SELECT * FROM t WHERE a = ';'")); // 分号在字符串内不算多语句
                                                                 // Writes: must go through execute to expose rows_affected.
        assert!(!is_read_query("UPDATE t SET a = 1"));
        assert!(!is_read_query("INSERT INTO t VALUES (1)"));
        assert!(!is_read_query("DELETE FROM t WHERE id = 1"));
        assert!(!is_read_query("REPLACE INTO t VALUES (1)"));
        assert!(!is_read_query("CREATE TABLE t (id INT)"));
        assert!(!is_read_query("DROP TABLE t"));
        assert!(!is_read_query("ALTER TABLE t ADD COLUMN x INT"));
        assert!(!is_read_query("TRUNCATE TABLE t"));
        assert!(!is_read_query("SET @x = 1"));
        assert!(!is_read_query("CALL sp()"));
    }

    #[test]
    fn has_unquoted_semicolon_detects_statement_breaks() {
        assert!(!has_unquoted_semicolon("SELECT * FROM t WHERE x = 'a;b'"));
        assert!(!has_unquoted_semicolon("SELECT * FROM t WHERE x = \"a;b\""));
        assert!(has_unquoted_semicolon(
            "SELECT * FROM t; SHOW CREATE TABLE t"
        ));
        assert!(has_unquoted_semicolon("SELECT * FROM t;"));
    }
}
