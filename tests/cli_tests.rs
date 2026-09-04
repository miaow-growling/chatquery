use chatquery::cli::conn::parse_dsn;
use chatquery::cli::install::is_dir_in_path;
use chatquery::cli::query::truncate_chars;
use chatquery::db::connection::DbType;
use chatquery::db::container::LegacyConnection;
use chatquery::db::mysql::{is_read_query, is_single_statement, statement_keyword};
use chatquery::sql_guard;
use std::path::Path;

#[test]
fn test_parse_dsn_mysql() {
    let dsn = "mysql://root:secret123@127.0.0.1:3306/ecommerce_db";
    let cfg = parse_dsn(dsn).expect("parse mysql dsn failed");
    assert_eq!(cfg.db_type, DbType::Mysql);
    assert_eq!(cfg.user, "root");
    assert_eq!(cfg.password, "secret123");
    assert_eq!(cfg.host, "127.0.0.1");
    assert_eq!(cfg.port, 3306);
    assert_eq!(cfg.database, "ecommerce_db");
}

#[test]
fn test_parse_dsn_redis() {
    let dsn = "redis://:redis_pwd@10.0.0.5:6379/1";
    let cfg = parse_dsn(dsn).expect("parse redis dsn failed");
    assert_eq!(cfg.db_type, DbType::Redis);
    assert_eq!(cfg.password, "redis_pwd");
    assert_eq!(cfg.host, "10.0.0.5");
    assert_eq!(cfg.port, 6379);
    assert_eq!(cfg.database, "1");
}

#[test]
fn test_guard_risk_detection() {
    // 危险的无 WHERE 更新
    let unsafe_sql = "UPDATE users SET active = 1";
    let risks = sql_guard::analyze_write_sql(unsafe_sql);
    assert!(!risks.is_empty(), "应当检测到无 WHERE 全表更新风险");

    // 安全的带 WHERE 更新
    let safe_sql = "UPDATE users SET active = 1 WHERE id = 100";
    let risks = sql_guard::analyze_write_sql(safe_sql);
    assert!(risks.is_empty(), "带 WHERE 的更新不应当被拦截");
}

#[test]
fn test_is_dir_in_path() {
    let dummy_path = Path::new("/nonexistent_path_chatquery_test_12345");
    assert!(!is_dir_in_path(dummy_path));
}

#[test]
fn test_parse_dsn_supports_encoded_credentials_and_ipv6() {
    let cfg = parse_dsn("mysql://user:p%40ss@[::1]:3307/my%20db").unwrap();
    assert_eq!(cfg.host, "[::1]");
    assert_eq!(cfg.password, "p@ss");
    assert_eq!(cfg.database, "my db");
    assert_eq!(cfg.port, 3307);
}

#[test]
fn test_cte_write_is_not_read_only() {
    assert!(is_read_query(
        "WITH ids AS (SELECT id FROM users) SELECT * FROM ids"
    ));
    assert!(!is_read_query(
        "WITH ids AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM ids)"
    ));
    assert!(!is_read_query("WITH ids AS (SELECT id FROM users) UPDATE users SET active=0 WHERE id IN (SELECT id FROM ids)"));
    assert_eq!(
        statement_keyword("WITH x AS (SELECT 1) INSERT INTO logs(id) SELECT * FROM x"),
        "INSERT"
    );
}

#[test]
fn test_multi_statement_queries_are_rejected() {
    assert!(is_single_statement("SELECT 1;"));
    assert!(!is_single_statement(
        "SELECT 1; INSERT INTO logs(id) VALUES (1)"
    ));
    assert!(!is_single_statement(
        "SELECT 1; DELETE FROM users WHERE id = 1"
    ));
}

#[test]
fn test_unicode_truncation_never_slices_utf8() {
    assert_eq!(truncate_chars("中文字符测试内容", 6), "中文字...");
    assert_eq!(truncate_chars("😀😀😀😀😀", 4), "😀...");
    assert_eq!(truncate_chars("短文本", 10), "短文本");
}

#[test]
fn test_legacy_connection_preserves_ssh_and_ssl_fields() {
    let json = serde_json::json!({
        "id": "c1", "name": "secure", "db_type": "mysql",
        "host": "db", "port": 3306, "user": "u", "password": "p", "database": "d",
        "ssl_mode": "required", "ssl_ca": "ca.pem", "client_cert": "cert.pem", "client_key": "key.pem",
        "ssh_host": "bastion", "ssh_port": 2222, "ssh_user": "ops", "ssh_auth_kind": "key",
        "ssh_password": "", "ssh_private_key": "~/.ssh/id_rsa", "group_id": "g1"
    });
    let cfg: LegacyConnection = serde_json::from_value(json).unwrap();
    assert_eq!(cfg.ssl_mode, "required");
    assert_eq!(cfg.ssh_host, "bastion");
    assert_eq!(cfg.ssh_port, 2222);
    assert_eq!(cfg.ssh_private_key, "~/.ssh/id_rsa");
}
