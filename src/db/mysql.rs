use crate::db::connection::ConnectionConfig;
use crate::error::{AppError, Result};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use regex::Regex;
use sqlx::{Column, Row, ValueRef};
use std::sync::OnceLock;

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
}

/// Execute a SQL string against MySQL and return a bounded, streamed result.
/// Only up to PAGE_LIMIT rows are retained in memory.
///
/// `database` selects the schema context for the query. When `None` (or empty)
/// the connection's default database is used — this is how ad-hoc SQL runs when
/// no specific database is selected in the tree. When set, the query connects
/// directly to that schema so unqualified table names resolve against it.
pub async fn query(
    cfg: &ConnectionConfig,
    sql: &str,
    database: Option<&str>,
) -> Result<QueryResult> {
    let pool = match database {
        Some(db) if !db.is_empty() => connect_pool_db(cfg, db).await?,
        _ => connect_pool(cfg).await?,
    };
    let mut stream = sqlx::query(sql).fetch(&pool);
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
            // 一旦 break，MySQL 连接会停在 streaming 脏状态，pool.close()
            // 必须等未读流被排空/重置，慢库或高延迟网络上会卡住（表现为
            // 前端“执行超时”）。读够后继续丢弃超出行直至 EOF 才最干净。
            truncated = true;
        }
    }

    pool.close().await;
    Ok(QueryResult {
        columns,
        rows,
        truncated,
        total: None,
        primary_keys: vec![],
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
) -> Result<QueryResult> {
    // Only single SELECT statements can safely be wrapped with COUNT(*)
    // and LIMIT/OFFSET. SHOW/EXPLAIN/INSERT/UPDATE/DELETE or multi-statement
    // scripts must run through the plain query path (no pager, no rewrite).
    if !is_select_query(sql) {
        return query(cfg, sql, database).await;
    }

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
    let total: Option<usize> = sqlx::query_scalar::<_, i64>(&count_sql)
        .fetch_one(&pool)
        .await
        .ok()
        .map(|n| n.max(0) as usize);

    // If the user supplied a LIMIT, paginate inside a derived table so we never
    // return rows beyond their requested cap.
    let page_sql = user_limit.map_or_else(
        || format!("{} LIMIT ? OFFSET ?", base),
        |limit| format!(
            "SELECT * FROM ({} LIMIT {}) AS _cq_limited LIMIT ? OFFSET ?",
            base, limit
        ),
    );
    let mut stream = sqlx::query(&page_sql)
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
    pool.close().await;
    Ok(QueryResult {
        columns,
        rows,
        truncated: false,
        total,
        primary_keys: vec![],
    })
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
    if !body.eq_ignore_ascii_case("select") && !body.to_ascii_uppercase().starts_with("SELECT ") {
        return false;
    }
    !has_unquoted_semicolon(no_tail)
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
            format!("0x{}", to_hex(&bytes))
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

/// Render a query result as CSV (UTF-8). Fields containing comma, quote, or
/// newline are quoted and inner quotes are doubled — enough for a local
/// export tool. Returns a string so it's unit-testable.
pub fn to_csv(r: &QueryResult) -> String {
    let mut s = String::new();
    s.push_str(&r.columns.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(","));
    s.push('\n');
    for row in &r.rows {
        s.push_str(&row.iter().map(|v| csv_field(v)).collect::<Vec<_>>().join(","));
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

/// Open a bounded MySQL pool (max 2 connections) for a single query/schema call.
/// Pools are short-lived and closed right after use (ADR-006: don't hold
/// connections we aren't actively using — keeps sockets and memory bounded).
async fn connect_pool(cfg: &ConnectionConfig) -> Result<MySqlPool> {
    let db = if cfg.database.is_empty() { "mysql" } else { &cfg.database };
    connect_pool_db(cfg, db).await
}

/// Like `connect_pool` but targets an explicit database — used by the schema
/// tree (browse any database, not just the connection's default).
async fn connect_pool_db(cfg: &ConnectionConfig, database: &str) -> Result<MySqlPool> {
    let db = if database.is_empty() { "mysql" } else { database };
    let url = format!(
        "mysql://{}:{}@{}:{}/{}?charset=utf8mb4",
        cfg.user, cfg.password, cfg.host, cfg.port, db
    );
    MySqlPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .map_err(AppError::Sqlx)
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
    let pool = connect_pool_db(cfg, &db).await?;
    // CAST every INFORMATION_SCHEMA text column to CHAR so sqlx decodes them as
    // VARCHAR instead of BINARY (binary charset would break String mapping).
    let rows = sqlx::query(
        "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, \
                CAST(DATA_TYPE AS CHAR) AS DATA_TYPE, CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY, \
                CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE, CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT \
         FROM INFORMATION_SCHEMA.COLUMNS \
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
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
            }],
        });
    }
    pool.close().await;
    Ok(Schema { tables })
}

/// Lightweight connectivity check used by the connection form.
pub async fn test(cfg: &ConnectionConfig) -> Result<()> {
    let pool = connect_pool(cfg).await?;
    sqlx::query("SELECT 1").execute(&pool).await.map_err(AppError::Sqlx)?;
    pool.close().await;
    Ok(())
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
}

/// List non-system databases on the server (Navicat's "database" level).
pub async fn list_databases(cfg: &ConnectionConfig) -> Result<Vec<String>> {
    let pool = connect_pool_db(cfg, "mysql").await?;
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
    pool.close().await;
    Ok(out)
}

/// List tables and views within a single database, ordered by name.
pub async fn list_tables(cfg: &ConnectionConfig, database: &str) -> Result<Vec<TableMeta>> {
    let pool = connect_pool_db(cfg, database).await?;
    // INFORMATION_SCHEMA text columns are defined with a binary charset in MySQL,
    // so sqlx reports them as SQL type BINARY and refuses to map them to String.
    // CAST to CHAR so they come back as VARCHAR (see list_tables/schema/describe_table).
    let rows = sqlx::query(
        "SELECT CAST(TABLE_NAME AS CHAR) AS TABLE_NAME, CAST(TABLE_TYPE AS CHAR) AS TABLE_TYPE \
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
        out.push(TableMeta {
            name,
            is_view: ttype.eq_ignore_ascii_case("VIEW"),
        });
    }
    pool.close().await;
    Ok(out)
}

/// List columns of a single table/view, including key/nullable/default.
pub async fn list_columns(
    cfg: &ConnectionConfig,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>> {
    let pool = connect_pool_db(cfg, database).await?;
    let rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_DEFAULT \
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
        out.push(ColumnInfo {
            name,
            data_type,
            key,
            nullable,
            default,
        });
    }
    pool.close().await;
    Ok(out)
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
    pool.close().await;
    Ok(QueryResult {
        columns,
        rows,
        truncated: false,
        total: Some(total.max(0) as usize),
        primary_keys,
    })
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
    pool.close().await;
    Ok(())
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
    pool.close().await;
    Ok(())
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
    pool.close().await;
    Ok(())
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
    let pool = connect_pool_db(cfg, database).await?;

    // 1. Column details — use COLUMN_TYPE (full) and EXTRA which list_columns
    //    doesn't select.
    // CAST every INFORMATION_SCHEMA text column to CHAR so sqlx decodes them as
    // VARCHAR instead of BINARY (binary charset would break String mapping).
    let col_rows = sqlx::query(
        "SELECT CAST(COLUMN_NAME AS CHAR) AS COLUMN_NAME, CAST(COLUMN_TYPE AS CHAR) AS COLUMN_TYPE, \
                CAST(IS_NULLABLE AS CHAR) AS IS_NULLABLE, CAST(COLUMN_KEY AS CHAR) AS COLUMN_KEY, \
                CAST(COLUMN_DEFAULT AS CHAR) AS COLUMN_DEFAULT, CAST(EXTRA AS CHAR) AS EXTRA \
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
        columns.push(ColumnDetail {
            name,
            column_type,
            nullable: nullable_str.eq_ignore_ascii_case("YES"),
            key,
            default,
            extra,
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

    pool.close().await;
    Ok(TableStructure {
        columns,
        indexes,
        create_sql,
    })
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
        let referenced_table: String =
            row.try_get("REFERENCED_TABLE_NAME").map_err(AppError::Sqlx)?;
        let referenced_column: String =
            row.try_get("REFERENCED_COLUMN_NAME").map_err(AppError::Sqlx)?;
        out.push(ForeignKeyInfo {
            constraint_name,
            table_name,
            column_name,
            referenced_table,
            referenced_column,
        });
    }
    pool.close().await;
    Ok(out)
}

/// Quote a SQL identifier safely: strip any backtick (so a name containing one
/// can't escape the quotes) then wrap in backticks. Preserves spaces and other
/// legal characters, unlike an alphanumeric sanitizer.
fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', ""))
}

/// Fully-qualified table reference: `db`.`tbl`, joined by a DOT. A space here
/// is a real bug — it makes MySQL read the database as a table name (see the
/// "Table 'kf_ai.kf_ai' doesn't exist" regression). Kept as its own function so
/// it can be unit-tested without a live database.
fn qualified_table(database: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_csv_quotes_special_fields() {
        let r = QueryResult {
            columns: vec!["id".into(), "name".into()],
            rows: vec![vec!["1".into(), "a,b".into()], vec!["2".into(), "he said \"hi\"".into()]],
            truncated: false,
            total: None,
            primary_keys: vec![],
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
    fn has_unquoted_semicolon_detects_statement_breaks() {
        assert!(!has_unquoted_semicolon("SELECT * FROM t WHERE x = 'a;b'"));
        assert!(!has_unquoted_semicolon("SELECT * FROM t WHERE x = \"a;b\""));
        assert!(has_unquoted_semicolon("SELECT * FROM t; SHOW CREATE TABLE t"));
        assert!(has_unquoted_semicolon("SELECT * FROM t;"));
    }
}
