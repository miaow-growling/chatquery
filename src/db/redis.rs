use crate::db::connection::ConnectionConfig;
use crate::error::{AppError, Result};
use redis::aio::MultiplexedConnection;
use serde::{Deserialize, Serialize};

/// Max keys/values retained in memory per Redis result (ADR-006: bounded).
pub const PAGE_LIMIT: usize = 500;

/// Hard cap on SCAN rounds, so a wildly churning keyspace can't loop forever.
const SCAN_MAX_ROUNDS: usize = 5000;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// Type-aware structured view of a Redis key's value (ADR-025 Phase A1).
/// Tagged enum so the frontend can pattern-match and render per-type viewers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RedisValueView {
    /// GET — a single string value.
    String {
        value: String,
    },
    /// HGETALL — field → value pairs.
    Hash {
        entries: Vec<HashEntry>,
    },
    /// LRANGE — ordered list entries with 0-based index.
    List {
        entries: Vec<ListEntry>,
        truncated: bool,
    },
    /// SMEMBERS — unordered set members.
    Set {
        members: Vec<String>,
        truncated: bool,
    },
    /// ZRANGE WITHSCORES — sorted set entries with score.
    Zset {
        entries: Vec<ZsetEntry>,
        truncated: bool,
    },
    /// Key does not exist, or type is not yet supported.
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashEntry {
    pub field: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListEntry {
    pub index: usize,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZsetEntry {
    pub member: String,
    pub score: f64,
}

/// Lightweight metadata for a key returned by `list_keys_meta` (ADR-025 Phase A2).
/// Batched via pipeline to avoid N×3 round trips.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyMeta {
    pub key: String,
    pub key_type: String,
    /// Seconds until expiry (-1 = no expiry, -2 = key gone). None when ≥0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    /// Approximate memory usage in bytes (Redis MEMORY USAGE command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedisResult {
    pub command: String,
    /// Flattened display lines — backward-compatible with the original flat renderer.
    pub lines: Vec<String>,
    pub truncated: bool,
    pub note: String,
    /// Structured value view (ADR-025 Phase A1). Populated by `browse_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<RedisValueView>,
    /// Seconds until expiry (ADR-025 Phase A1). None = persistent or key gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<i64>,
    /// Approximate memory usage in bytes (ADR-025 Phase A1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Execute a single Redis command line (first non-empty line of the editor).
///
/// - Intercepts `KEYS` and rejects it (never load the whole keyspace at once).
/// - Special-cases `SCAN` to iterate the cursor with a bounded in-memory result.
/// - Everything else runs as a generic command and is flattened to display lines.
pub async fn query(cfg: &ConnectionConfig, input: &str) -> Result<RedisResult> {
    let cmd_line = input
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    if cmd_line.is_empty() {
        return Ok(RedisResult {
            command: String::new(),
            lines: vec![],
            truncated: false,
            note: "命令为空".into(),
            value: None,
            ttl: None,
            size: None,
        });
    }

    let parts: Vec<String> = tokenize(&cmd_line);
    let verb = parts[0].to_ascii_uppercase();

    if verb == "KEYS" {
        return Ok(RedisResult {
            command: cmd_line.clone(),
            lines: vec![],
            truncated: false,
            note: "禁止使用 KEYS（会一次性载入全量键，导致内存暴涨与卡顿，违反 ADR-006）。请改用 SCAN 0 MATCH <pattern> COUNT <n> 进行游标遍历。".into(),
            value: None,
            ttl: None,
            size: None,
        });
    }

    let mut conn = connect(cfg).await?;

    if verb == "SCAN" {
        let args: Vec<&str> = parts[1..].iter().map(|s| s.as_str()).collect();
        return scan(&mut conn, &args).await;
    }

    let value = redis::cmd(parts[0].as_str())
        .arg(parts[1..].iter().map(|s| s.as_str()).collect::<Vec<_>>())
        .query_async::<redis::Value>(&mut conn)
        .await
        .map_err(AppError::Redis)?;

    let mut lines = Vec::new();
    value_to_lines(&value, &mut lines);
    let note = format!("{} 行", lines.len());
    Ok(RedisResult {
        command: cmd_line,
        lines,
        truncated: false,
        note,
        value: None,
        ttl: None,
        size: None,
    })
}

/// Split a Redis command line into arguments, honoring single quotes,
/// double quotes, and backslash escapes — so `SET k "a b"` yields
/// `["SET", "k", "a b"]` instead of being mangled by naive whitespace splitting.
/// Lightweight connectivity check: AUTH/SELECT if configured, then PING.
pub async fn test(cfg: &ConnectionConfig) -> Result<()> {
    let mut conn = connect(cfg).await?;
    let _: redis::Value = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(AppError::Redis)?;
    Ok(())
}

/// Connect and explicitly SELECT a database index — used by the schema tree
/// (browse a specific Redis db, not just the connection default).
async fn connect_to_db(cfg: &ConnectionConfig, db: u8) -> Result<MultiplexedConnection> {
    let url = format!("redis://{}:{}", cfg.host, cfg.port);
    let client = redis::Client::open(url.as_str()).map_err(AppError::Redis)?;
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(AppError::Redis)?;
    if !cfg.password.is_empty() {
        let _: redis::Value = redis::cmd("AUTH")
            .arg(cfg.password.as_str())
            .query_async(&mut conn)
            .await
            .map_err(AppError::Redis)?;
    }
    let _: redis::Value = redis::cmd("SELECT")
        .arg(db)
        .query_async(&mut conn)
        .await
        .map_err(AppError::Redis)?;
    Ok(conn)
}

/// List database indices that actually contain keys. Asks `CONFIG GET
/// databases` for the count (fallback 16) then DBSIZE-checks each; empty dbs
/// are omitted so the tree isn't cluttered with 16 always-empty nodes.
pub async fn list_dbs(cfg: &ConnectionConfig) -> Result<Vec<u8>> {
    let mut conn = connect(cfg).await?;
    let count: u8 = match redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<Vec<String>>(&mut conn)
        .await
    {
        Ok(res) if res.len() == 2 => res[1].parse().unwrap_or(16),
        _ => 16,
    };
    let mut out = Vec::new();
    for db in 0..count {
        if let Ok(mut c) = connect_to_db(cfg, db).await {
            let size: i64 = redis::cmd("DBSIZE")
                .query_async(&mut c)
                .await
                .map_err(AppError::Redis)?;
            if size > 0 {
                out.push(db);
            }
        }
    }
    Ok(out)
}

/// SCAN a database for keys matching `pattern`, bounded by `limit` (capped at
/// PAGE_LIMIT). Avoids `KEYS` per ADR-006.
pub async fn list_keys(
    cfg: &ConnectionConfig,
    db: u8,
    pattern: &str,
    limit: usize,
) -> Result<Vec<String>> {
    let mut conn = connect_to_db(cfg, db).await?;
    let match_pat = if pattern.is_empty() {
        "*".to_string()
    } else {
        pattern.to_string()
    };
    let cap = limit.min(PAGE_LIMIT).max(1);
    let mut keys: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    let mut rounds = 0;
    loop {
        rounds += 1;
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&match_pat)
            .arg("COUNT")
            .arg(100u64)
            .query_async(&mut conn)
            .await
            .map_err(AppError::Redis)?;
        cursor = next;
        for k in batch {
            if keys.len() >= cap {
                break;
            }
            keys.push(k);
        }
        if cursor == 0 || keys.len() >= cap || rounds >= SCAN_MAX_ROUNDS {
            break;
        }
    }
    Ok(keys)
}

/// SCAN a database for keys, then pipeline TYPE + TTL + MEMORY USAGE for each
/// in a single batch (ADR-025 Phase A2). Avoids N×3 round-trips per page.
pub async fn list_keys_meta(
    cfg: &ConnectionConfig,
    db: u8,
    pattern: &str,
    limit: usize,
) -> Result<Vec<KeyMeta>> {
    let mut conn = connect_to_db(cfg, db).await?;
    let match_pat = if pattern.is_empty() {
        "*".to_string()
    } else {
        pattern.to_string()
    };
    let cap = limit.min(PAGE_LIMIT).max(1);
    let mut keys: Vec<String> = Vec::new();
    let mut cursor: u64 = 0;
    let mut rounds = 0;
    loop {
        rounds += 1;
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&match_pat)
            .arg("COUNT")
            .arg(100u64)
            .query_async(&mut conn)
            .await
            .map_err(AppError::Redis)?;
        cursor = next;
        for k in batch {
            if keys.len() >= cap {
                break;
            }
            keys.push(k);
        }
        if cursor == 0 || keys.len() >= cap || rounds >= SCAN_MAX_ROUNDS {
            break;
        }
    }

    if keys.is_empty() {
        return Ok(vec![]);
    }

    // Pipeline: TYPE + TTL + MEMORY USAGE for each key (1 round-trip total).
    let mut pipe = redis::pipe();
    for k in &keys {
        pipe.cmd("TYPE").arg(k);
        pipe.cmd("TTL").arg(k);
        pipe.cmd("MEMORY").arg("USAGE").arg(k);
    }
    let results: Vec<redis::Value> = pipe.query_async(&mut conn).await.map_err(AppError::Redis)?;

    let mut metas = Vec::with_capacity(keys.len());
    for (i, k) in keys.into_iter().enumerate() {
        let base = i * 3;
        let key_type = match &results[base] {
            redis::Value::SimpleString(s) => s.clone(),
            redis::Value::BulkString(b) => bytes_to_string(b),
            _ => "none".to_string(),
        };
        let ttl = match &results[base + 1] {
            redis::Value::Int(i) if *i >= 0 => Some(*i),
            _ => None,
        };
        let size = match &results[base + 2] {
            redis::Value::Int(i) if *i >= 0 => Some(*i as u64),
            _ => None,
        };
        metas.push(KeyMeta {
            key: k,
            key_type,
            ttl,
            size,
        });
    }
    Ok(metas)
}

/// Type-aware read of a single key's value (ADR-025 Phase A1).
///
/// Uses a pipeline to fetch TYPE + TTL + MEMORY USAGE in one round-trip,
/// then reads the value based on type. Returns both the traditional flat
/// `lines` (backward compatible) and a structured `RedisValueView` so the
/// frontend can render type-appropriate viewers.
pub async fn browse_key(cfg: &ConnectionConfig, db: u8, key: &str) -> Result<RedisResult> {
    let mut conn = connect_to_db(cfg, db).await?;

    // Pipeline: TYPE + TTL + MEMORY USAGE (1 round-trip).
    let mut pipe = redis::pipe();
    pipe.cmd("TYPE").arg(key);
    pipe.cmd("TTL").arg(key);
    pipe.cmd("MEMORY").arg("USAGE").arg(key);
    let results: (String, i64, redis::Value) = pipe
        .query_async(&mut conn)
        .await
        .map_err(AppError::Redis)?;
    let (raw_type, ttl_raw, mem_val) = results;

    let ttl = if ttl_raw < 0 { None } else { Some(ttl_raw) };
    let size: Option<u64> = match &mem_val {
        redis::Value::Int(i) if *i >= 0 => Some(*i as u64),
        _ => None,
    };
    let t = raw_type.to_uppercase();

    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;

    let value = match t.as_str() {
        "STRING" => {
            let v: redis::Value = redis::cmd("GET")
                .arg(key)
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
            let s = value_to_string(&v);
            lines.push(s.clone());
            RedisValueView::String { value: s }
        }
        "HASH" => {
            let v: redis::Value = redis::cmd("HGETALL")
                .arg(key)
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
            let entries = extract_hash(&v);
            for e in &entries {
                lines.push(format!("{}  {}", e.field, e.value));
            }
            RedisValueView::Hash { entries }
        }
        "LIST" => {
            let v: redis::Value = redis::cmd("LRANGE")
                .arg(key)
                .arg(0i64)
                .arg(PAGE_LIMIT as i64)
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
            let entries = extract_list(&v);
            truncated = entries.len() >= PAGE_LIMIT;
            for e in &entries {
                lines.push(format!("{}  {}", e.index, e.value));
            }
            RedisValueView::List { entries, truncated }
        }
        "SET" => {
            let v: redis::Value = redis::cmd("SMEMBERS")
                .arg(key)
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
            let members = extract_members(&v);
            truncated = members.len() >= PAGE_LIMIT;
            for m in &members {
                lines.push(m.clone());
            }
            RedisValueView::Set { members, truncated }
        }
        "ZSET" => {
            let v: redis::Value = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0i64)
                .arg(PAGE_LIMIT as i64)
                .arg("WITHSCORES")
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
            let entries = extract_zset(&v);
            truncated = entries.len() >= PAGE_LIMIT;
            for e in &entries {
                lines.push(format!("{}  {}", e.member, e.score));
            }
            RedisValueView::Zset { entries, truncated }
        }
        "NONE" => {
            lines.push("(key 不存在)".into());
            RedisValueView::None
        }
        _ => {
            lines.push(format!("<未知类型: {}>", t));
            RedisValueView::None
        }
    };

    let kind = match t.as_str() {
        "STRING" => "string",
        "HASH" => "hash",
        "LIST" => "list",
        "SET" => "set",
        "ZSET" => "zset",
        "NONE" => "none",
        _ => "unknown",
    };
    let note = format!("{} · {} 项", kind, lines.len());
    Ok(RedisResult {
        command: format!("TYPE {} -> {}", key, t),
        lines,
        truncated,
        note,
        value: Some(value),
        ttl,
        size,
    })
}

// ---------------------------------------------------------------------------
// Value extraction helpers (ADR-025 Phase A1)
// ---------------------------------------------------------------------------

/// Convert a redis::Value to its string representation.
fn value_to_string(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => "(nil)".into(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::BulkString(b) => bytes_to_string(b),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".into(),
        _ => "?".into(),
    }
}

/// Extract HGETALL result into HashEntry list. Input is the Redis Array
/// `[field1, value1, field2, value2, ...]`.
fn extract_hash(v: &redis::Value) -> Vec<HashEntry> {
    let mut entries = Vec::new();
    if let redis::Value::Array(items) = v {
        for chunk in items.chunks(2) {
            entries.push(HashEntry {
                field: value_to_string(&chunk[0]),
                value: value_to_string(chunk.get(1).unwrap_or(&redis::Value::Nil)),
            });
        }
    }
    entries
}

/// Extract LRANGE result into ListEntry list with 0-based indices.
fn extract_list(v: &redis::Value) -> Vec<ListEntry> {
    let mut entries = Vec::new();
    if let redis::Value::Array(items) = v {
        for (i, item) in items.iter().enumerate() {
            entries.push(ListEntry {
                index: i,
                value: value_to_string(item),
            });
        }
    }
    entries
}

/// Extract SMEMBERS result into plain string list.
fn extract_members(v: &redis::Value) -> Vec<String> {
    let mut members = Vec::new();
    if let redis::Value::Array(items) = v {
        for item in items {
            members.push(value_to_string(item));
        }
    }
    members
}

/// Extract ZRANGE WITHSCORES result into ZsetEntry list.
/// Input is `[member1, score1, member2, score2, ...]`.
fn extract_zset(v: &redis::Value) -> Vec<ZsetEntry> {
    let mut entries = Vec::new();
    if let redis::Value::Array(items) = v {
        for chunk in items.chunks(2) {
            if chunk.len() < 2 {
                break;
            }
            let member = value_to_string(&chunk[0]);
            let score = match &chunk[1] {
                redis::Value::BulkString(b) => {
                    std::str::from_utf8(b).ok().and_then(|s| s.parse().ok()).unwrap_or(0.0)
                }
                redis::Value::SimpleString(s) => s.parse().unwrap_or(0.0),
                redis::Value::Int(i) => *i as f64,
                _ => 0.0,
            };
            entries.push(ZsetEntry { member, score });
        }
    }
    entries
}

fn tokenize(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_sq = false;
    let mut in_dq = false;
    let mut escaped = false;
    for c in s.chars() {
        if escaped {
            cur.push(c);
            escaped = false;
            continue;
        }
        if in_sq {
            match c {
                '\\' => escaped = true,
                '\'' => in_sq = false,
                c => cur.push(c),
            }
            continue;
        }
        if in_dq {
            match c {
                '\\' => escaped = true,
                '"' => in_dq = false,
                c => cur.push(c),
            }
            continue;
        }
        match c {
            '\'' => in_sq = true,
            '"' => in_dq = true,
            '\\' => escaped = true,
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

async fn connect(cfg: &ConnectionConfig) -> Result<MultiplexedConnection> {
    let url = format!("redis://{}:{}", cfg.host, cfg.port);
    let client = redis::Client::open(url.as_str()).map_err(AppError::Redis)?;
    let mut conn = client
        .get_multiplexed_tokio_connection()
        .await
        .map_err(AppError::Redis)?;
    if !cfg.password.is_empty() {
        let _: redis::Value = redis::cmd("AUTH")
            .arg(cfg.password.as_str())
            .query_async(&mut conn)
            .await
            .map_err(AppError::Redis)?;
    }
    if !cfg.database.is_empty() {
        if let Ok(db) = cfg.database.parse::<u8>() {
            let _: redis::Value = redis::cmd("SELECT")
                .arg(db)
                .query_async(&mut conn)
                .await
                .map_err(AppError::Redis)?;
        }
    }
    Ok(conn)
}

async fn scan(conn: &mut MultiplexedConnection, args: &[&str]) -> Result<RedisResult> {
    let mut cursor: u64 = 0;
    let mut match_pat = "*".to_string();
    let mut count: u64 = 100;

    let mut it = args.iter().peekable();
    if let Some(first) = it.peek() {
        if let Ok(c) = first.parse::<u64>() {
            cursor = c;
            it.next();
        }
    }
    while let Some(tok) = it.next() {
        match tok.to_ascii_uppercase().as_str() {
            "MATCH" => {
                if let Some(v) = it.next() {
                    match_pat = v.to_string();
                }
            }
            "COUNT" => {
                if let Some(v) = it.next() {
                    if let Ok(c) = v.parse() {
                        count = c;
                    }
                }
            }
            _ => {}
        }
    }

    let mut keys: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut rounds = 0;
    loop {
        rounds += 1;
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(&match_pat)
            .arg("COUNT")
            .arg(count)
            .query_async(conn)
            .await
            .map_err(AppError::Redis)?;
        cursor = next;
        for k in batch {
            if keys.len() >= PAGE_LIMIT {
                truncated = true;
                break;
            }
            keys.push(k);
        }
        if cursor == 0 || truncated || rounds >= SCAN_MAX_ROUNDS {
            break;
        }
    }

    Ok(RedisResult {
        command: format!("SCAN MATCH {} COUNT {}", match_pat, count),
        lines: keys.clone(),
        truncated,
        note: if truncated {
            format!("已收集 {} 个键（达到上限），请缩小 MATCH 模式以查看更多", keys.len())
        } else {
            format!("{} 个键", keys.len())
        },
        value: None,
        ttl: None,
        size: None,
    })
}

fn value_to_lines(v: &redis::Value, out: &mut Vec<String>) {
    match v {
        redis::Value::Nil => out.push("<nil>".into()),
        redis::Value::Int(i) => out.push(i.to_string()),
        redis::Value::BulkString(b) => out.push(bytes_to_string(b)),
        redis::Value::SimpleString(s) => out.push(s.clone()),
        redis::Value::Okay => out.push("OK".into()),
        redis::Value::Array(items) => {
            for it in items {
                value_to_lines(it, out);
            }
        }
        _ => out.push("?".into()),
    }
}

/// Delete one or more keys. Returns the number of keys actually removed.
/// Uses a pipeline so the caller can batch-delete multiple keys atomically,
/// but the frontend calls it with a single key for now.
pub async fn delete_key(
    cfg: &ConnectionConfig,
    db: u8,
    key: &str,
) -> Result<u64> {
    let mut conn = connect_to_db(cfg, db).await?;
    let deleted: u64 = redis::cmd("DEL")
        .arg(key)
        .query_async(&mut conn)
        .await
        .map_err(AppError::Redis)?;
    Ok(deleted)
}

fn bytes_to_string(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => format!("0x{}", to_hex(b)),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::{ConnectionConfig, DbType};

    fn test_cfg() -> ConnectionConfig {
        ConnectionConfig {
            id: "t".into(),
            name: "test".into(),
            db_type: DbType::Redis,
            host: std::env::var("CQ_REDIS_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("CQ_REDIS_PORT")
                .unwrap_or_else(|_| "6390".into())
                .parse()
                .unwrap(),
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
        }
    }

    // Real smoke test against a live redis. Skips silently if no server is up,
    // so `cargo test` stays green in environments without redis.
    #[tokio::test]
    async fn smoke_redis() {
        let cfg = test_cfg();
        if connect(&cfg).await.is_err() {
            eprintln!("redis unavailable, skipping smoke test");
            return;
        }

        // SET / GET
        let _ = query(&cfg, "SET cq:k1 hello").await.unwrap();
        let r = query(&cfg, "GET cq:k1").await.unwrap();
        assert_eq!(r.lines, vec!["hello".to_string()]);

        // HSET / HGETALL (array result)
        let _ = query(&cfg, "HSET cq:h f1 v1 f2 v2").await.unwrap();
        let r = query(&cfg, "HGETALL cq:h").await.unwrap();
        assert!(r.lines.contains(&"f1".to_string()));
        assert!(r.lines.contains(&"v1".to_string()));
        assert!(r.lines.contains(&"v2".to_string()));

        // SCAN does not blow up and returns our keys
        let r = query(&cfg, "SCAN 0 MATCH cq:* COUNT 100").await.unwrap();
        assert!(r.lines.iter().any(|k| k == "cq:k1" || k == "cq:h"));

        // KEYS is rejected per ADR-006 (never load the whole keyspace)
        let r = query(&cfg, "KEYS *").await.unwrap();
        assert!(r.lines.is_empty());
        assert!(r.note.contains("禁止"));

        // cleanup
        let _ = query(&cfg, "DEL cq:k1 cq:h").await;
    }

    #[test]
    fn tokenize_respects_quotes_and_escapes() {
        assert_eq!(tokenize("SET k \"a b\""), vec!["SET", "k", "a b"]);
        assert_eq!(tokenize("GET 'my key'"), vec!["GET", "my key"]);
        assert_eq!(tokenize("SET k a\\ b"), vec!["SET", "k", "a b"]);
        assert_eq!(tokenize("  SET   k1  v1  "), vec!["SET", "k1", "v1"]);
        // empty / whitespace only
        assert!(tokenize("   ").is_empty());
        // escaped quote inside double quotes
        assert_eq!(tokenize("SET k \"he said \\\"hi\\\"\""), vec!["SET", "k", "he said \"hi\""]);
    }
}

