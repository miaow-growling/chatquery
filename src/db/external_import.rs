//! Parsers for external database connection configurations:
//! - Navicat (.ncx XML or JSON)
//! - DataGrip / JetBrains IDEs (dataSources.xml, clipboard XML)
//! - Raw URI / JDBC connection strings (line-separated or single)

use crate::db::connection::DbType;
use crate::error::{AppError, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::collections::HashMap;

/// Standardized intermediate connection representation extracted from external formats.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalConn {
    pub name: String,
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    pub env: Option<String>,
    pub group: Option<String>,
    pub ssl_mode: String,
    pub ssl_ca: String,
    pub client_cert: String,
    pub client_key: String,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub ssh_auth_kind: String,
    pub ssh_password: String,
    pub ssh_private_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalFormat {
    NavicatXml,
    NavicatJson,
    DataGripXml,
    RawUriList,
}

/// Detect whether the input string matches any known external connection format.
pub fn detect_external_format(text: &str) -> Option<ExternalFormat> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Check XML-like formats
    if trimmed.starts_with('<') || trimmed.contains("<?xml") {
        let lower = trimmed.to_lowercase();
        if lower.contains("<connection ")
            || lower.contains("<connections")
            || lower.contains("<navicatcon")
        {
            return Some(ExternalFormat::NavicatXml);
        }
        if lower.contains("<data-source")
            || lower.contains("<data-sources")
            || lower.contains("datasourcemanagerimpl")
            || (lower.contains("<jdbc-url>") && lower.contains("<user-name>"))
        {
            return Some(ExternalFormat::DataGripXml);
        }
    }

    // Check JSON formats (excluding ChatQuery native export)
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && !trimmed.contains("chatquery-connections")
    {
        if trimmed.contains("\"ConnType\"")
            || trimmed.contains("\"ConnectionName\"")
            || trimmed.contains("\"conn_type\"")
        {
            return Some(ExternalFormat::NavicatJson);
        }
    }

    // Check raw JDBC / URI strings (skip empty or commented lines)
    let first_effective_line = trimmed
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("");
    if first_effective_line.starts_with("jdbc:")
        || first_effective_line.starts_with("mysql://")
        || first_effective_line.starts_with("mariadb://")
        || first_effective_line.starts_with("redis://")
    {
        return Some(ExternalFormat::RawUriList);
    }

    None
}

/// Parse external input according to detected format into normalized ExternalConn list.
pub fn parse_external_connections(text: &str) -> Result<Vec<ExternalConn>> {
    let fmt = detect_external_format(text)
        .ok_or_else(|| AppError::Msg("未能识别的外部连接格式".to_string()))?;

    match fmt {
        ExternalFormat::NavicatXml => parse_navicat_xml(text),
        ExternalFormat::NavicatJson => parse_navicat_json(text),
        ExternalFormat::DataGripXml => parse_datagrip_xml(text),
        ExternalFormat::RawUriList => parse_raw_uris(text),
    }
}

// ---------------------------------------------------------------------------
// Navicat XML / NCX parser
// ---------------------------------------------------------------------------

pub fn parse_navicat_xml(text: &str) -> Result<Vec<ExternalConn>> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut conns = Vec::new();
    let mut current_group: Option<String> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag_name == "group" {
                    for attr in e.attributes().flatten() {
                        let k = String::from_utf8_lossy(attr.key.as_ref()).to_lowercase();
                        if k == "groupname" || k == "name" {
                            let v = String::from_utf8_lossy(&attr.value).trim().to_string();
                            if !v.is_empty() {
                                current_group = Some(v);
                            }
                        }
                    }
                } else if tag_name == "connection" {
                    if let Some(c) = parse_navicat_connection_tag(e, current_group.as_deref()) {
                        conns.push(c);
                    }
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag_name == "connection" {
                    if let Some(c) = parse_navicat_connection_tag(e, current_group.as_deref()) {
                        conns.push(c);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag_name == "group" {
                    current_group = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(AppError::Msg(format!("Navicat XML 解析错误: {}", err)));
            }
            _ => {}
        }
        buf.clear();
    }

    if conns.is_empty() {
        return Err(AppError::Msg("Navicat XML 中未找到有效的 Connection 节点".into()));
    }

    Ok(conns)
}

fn parse_navicat_connection_tag(
    e: &quick_xml::events::BytesStart,
    group_ctx: Option<&str>,
) -> Option<ExternalConn> {
    let mut attrs: HashMap<String, String> = HashMap::new();
    for attr in e.attributes().flatten() {
        let k = String::from_utf8_lossy(attr.key.as_ref()).to_lowercase();
        let v = String::from_utf8_lossy(&attr.value).to_string();
        attrs.insert(k, v);
    }

    let name = attrs
        .get("connectionname")
        .or_else(|| attrs.get("connname"))
        .or_else(|| attrs.get("name"))
        .cloned()
        .unwrap_or_else(|| "Navicat-Import".to_string());

    let raw_type = attrs
        .get("conntype")
        .or_else(|| attrs.get("type"))
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| "MYSQL".to_string());

    let db_type = if raw_type.contains("REDIS") {
        DbType::Redis
    } else {
        // MYSQL, MARIADB, etc. default to MySQL
        DbType::Mysql
    };

    let host = attrs
        .get("host")
        .or_else(|| attrs.get("server"))
        .cloned()
        .unwrap_or_else(|| "127.0.0.1".to_string());

    let default_port = if db_type == DbType::Redis { 6379 } else { 3306 };
    let port = attrs
        .get("port")
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(default_port);

    let user = attrs
        .get("username")
        .or_else(|| attrs.get("user"))
        .cloned()
        .unwrap_or_else(|| if db_type == DbType::Redis { "default".to_string() } else { "root".to_string() });

    let database = attrs
        .get("database")
        .or_else(|| attrs.get("initialdatabase"))
        .or_else(|| attrs.get("db"))
        .cloned()
        .unwrap_or_default();

    let raw_pw = attrs.get("password").or_else(|| attrs.get("pwd")).cloned().unwrap_or_default();
    // If password is encrypted by Navicat or empty, keep raw if plaintext or empty for passwords_needed
    let password = sanitize_navicat_password(&raw_pw);

    // Grouping
    let group = attrs
        .get("group")
        .or_else(|| attrs.get("groupname"))
        .map(|s| s.clone())
        .or_else(|| group_ctx.map(|s| s.to_string()))
        .or_else(|| Some("Navicat 导入".to_string()));

    // SSH tunnel
    let ssh_host = attrs.get("ssh_host").or_else(|| attrs.get("sshhost")).cloned().unwrap_or_default();
    let ssh_port = attrs
        .get("ssh_port")
        .or_else(|| attrs.get("sshport"))
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(22);
    let ssh_user = attrs.get("ssh_username").or_else(|| attrs.get("sshuser")).cloned().unwrap_or_default();
    let ssh_password = attrs.get("ssh_password").or_else(|| attrs.get("sshpwd")).cloned().unwrap_or_default();
    let ssh_private_key = attrs.get("ssh_keyfile").or_else(|| attrs.get("sshkey")).cloned().unwrap_or_default();
    let ssh_auth_kind = if !ssh_private_key.is_empty() {
        "key".to_string()
    } else if !ssh_host.is_empty() {
        "password".to_string()
    } else {
        String::new()
    };

    // SSL
    let ssl_enabled = attrs
        .get("ssl_enabled")
        .map(|s| s == "true" || s == "1")
        .unwrap_or(false);
    let ssl_mode = if ssl_enabled { "required".to_string() } else { "disabled".to_string() };

    Some(ExternalConn {
        name,
        db_type,
        host,
        port,
        user,
        password,
        database,
        env: None,
        group,
        ssl_mode,
        ssl_ca: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh_host,
        ssh_port,
        ssh_user,
        ssh_auth_kind,
        ssh_password,
        ssh_private_key,
    })
}

/// If Navicat password is hex-encoded ciphertext, we empty it so ChatQuery's
/// passwords_needed mechanism prompts the user cleanly instead of passing garbage.
fn sanitize_navicat_password(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    // If it looks like hex-encoded Navicat encrypted password (even length >= 16 and all hex chars)
    if s.len() >= 16 && s.len() % 2 == 0 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        // Leave empty for passwords_needed prompt
        return String::new();
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Navicat JSON parser
// ---------------------------------------------------------------------------

pub fn parse_navicat_json(text: &str) -> Result<Vec<ExternalConn>> {
    let val: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::Msg(format!("Navicat JSON 解析失败: {}", e)))?;

    let mut conns = Vec::new();
    let items = if let Some(arr) = val.as_array() {
        arr.clone()
    } else if let Some(arr) = val.get("connections").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        vec![val]
    };

    for item in items {
        let name = item["ConnectionName"]
            .as_str()
            .or_else(|| item["name"].as_str())
            .unwrap_or("Navicat-Import")
            .to_string();

        let raw_type = item["ConnType"]
            .as_str()
            .or_else(|| item["type"].as_str())
            .unwrap_or("MYSQL")
            .to_uppercase();

        let db_type = if raw_type.contains("REDIS") {
            DbType::Redis
        } else {
            DbType::Mysql
        };

        let host = item["Host"]
            .as_str()
            .or_else(|| item["host"].as_str())
            .unwrap_or("127.0.0.1")
            .to_string();

        let port = item["Port"]
            .as_u64()
            .or_else(|| item["port"].as_u64())
            .map(|p| p as u16)
            .unwrap_or(if db_type == DbType::Redis { 6379 } else { 3306 });

        let user = item["UserName"]
            .as_str()
            .or_else(|| item["user"].as_str())
            .unwrap_or(if db_type == DbType::Redis { "default" } else { "root" })
            .to_string();

        let database = item["Database"]
            .as_str()
            .or_else(|| item["database"].as_str())
            .unwrap_or("")
            .to_string();

        let raw_pw = item["Password"]
            .as_str()
            .or_else(|| item["password"].as_str())
            .unwrap_or("");
        let password = sanitize_navicat_password(raw_pw);

        let group = item["Group"]
            .as_str()
            .or_else(|| item["group"].as_str())
            .map(|s| s.to_string())
            .or_else(|| Some("Navicat 导入".to_string()));

        let ssh_host = item["SSH_Host"].as_str().unwrap_or("").to_string();
        let ssh_port = item["SSH_Port"].as_u64().map(|p| p as u16).unwrap_or(22);
        let ssh_user = item["SSH_UserName"].as_str().unwrap_or("").to_string();

        conns.push(ExternalConn {
            name,
            db_type,
            host,
            port,
            user,
            password,
            database,
            env: None,
            group,
            ssl_mode: "disabled".to_string(),
            ssl_ca: String::new(),
            client_cert: String::new(),
            client_key: String::new(),
            ssh_host,
            ssh_port,
            ssh_user,
            ssh_auth_kind: String::new(),
            ssh_password: String::new(),
            ssh_private_key: String::new(),
        });
    }

    if conns.is_empty() {
        return Err(AppError::Msg("未在 JSON 中找到可识别的 Navicat 连接".into()));
    }

    Ok(conns)
}

// ---------------------------------------------------------------------------
// DataGrip / JetBrains XML parser
// ---------------------------------------------------------------------------

pub fn parse_datagrip_xml(text: &str) -> Result<Vec<ExternalConn>> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut conns = Vec::new();
    let mut buf = Vec::new();

    // Context tracking for current data-source
    let mut in_data_source = false;
    let mut current_name = String::new();
    let mut current_group: Option<String> = None;
    let mut current_jdbc_url = String::new();
    let mut current_user = String::new();
    let mut current_driver = String::new();

    // SSH fields
    let mut in_ssh = false;
    let mut ssh_host = String::new();
    let mut ssh_port: u16 = 22;
    let mut ssh_user = String::new();
    let mut ssh_auth_type = String::new();

    let mut current_tag = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                current_tag = tag.clone();

                if tag == "data-source" {
                    in_data_source = true;
                    current_name = "DataGrip-Import".to_string();
                    current_group = None;
                    current_jdbc_url.clear();
                    current_user.clear();
                    current_driver.clear();
                    in_ssh = false;
                    ssh_host.clear();
                    ssh_port = 22;
                    ssh_user.clear();
                    ssh_auth_type.clear();

                    for attr in e.attributes().flatten() {
                        let k = String::from_utf8_lossy(attr.key.as_ref()).to_lowercase();
                        let v = String::from_utf8_lossy(&attr.value).to_string();
                        if k == "name" && !v.trim().is_empty() {
                            current_name = v.trim().to_string();
                        }
                    }
                } else if tag == "ssh-properties" {
                    in_ssh = true;
                }
            }
            Ok(Event::Text(ref e)) => {
                if !in_data_source {
                    continue;
                }
                let text_val = e.unescape().unwrap_or_default().trim().to_string();
                if text_val.is_empty() {
                    continue;
                }

                if in_ssh {
                    match current_tag.as_str() {
                        "proxy-host" => ssh_host = text_val,
                        "proxy-port" => {
                            if let Ok(p) = text_val.parse::<u16>() {
                                ssh_port = p;
                            }
                        }
                        "user" => ssh_user = text_val,
                        "auth-type" => ssh_auth_type = text_val,
                        _ => {}
                    }
                } else {
                    match current_tag.as_str() {
                        "jdbc-url" => current_jdbc_url = text_val,
                        "user-name" => current_user = text_val,
                        "driver-ref" => current_driver = text_val,
                        "group-name" => current_group = Some(text_val),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if tag == "ssh-properties" {
                    in_ssh = false;
                } else if tag == "data-source" {
                    in_data_source = false;
                    // Build connection from extracted data
                    if let Some(conn) = build_datagrip_conn(
                        &current_name,
                        &current_jdbc_url,
                        &current_user,
                        &current_driver,
                        current_group.as_deref(),
                        &ssh_host,
                        ssh_port,
                        &ssh_user,
                        &ssh_auth_type,
                    ) {
                        conns.push(conn);
                    }
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                return Err(AppError::Msg(format!("DataGrip XML 解析错误: {}", err)));
            }
            _ => {}
        }
        buf.clear();
    }

    if conns.is_empty() {
        return Err(AppError::Msg("DataGrip XML 中未找到有效的数据源 (data-source)".into()));
    }

    Ok(conns)
}

fn build_datagrip_conn(
    name: &str,
    jdbc_url: &str,
    user: &str,
    driver_ref: &str,
    group_opt: Option<&str>,
    ssh_host: &str,
    ssh_port: u16,
    ssh_user: &str,
    ssh_auth_type: &str,
) -> Option<ExternalConn> {
    if jdbc_url.is_empty() {
        return None;
    }

    let parsed = parse_jdbc_url(jdbc_url, driver_ref)?;

    let user_final = if !user.is_empty() {
        user.to_string()
    } else if !parsed.user.is_empty() {
        parsed.user
    } else if parsed.db_type == DbType::Redis {
        "default".to_string()
    } else {
        "root".to_string()
    };

    let group = group_opt
        .map(|s| s.to_string())
        .or_else(|| Some("DataGrip 导入".to_string()));

    let ssh_auth_kind = if !ssh_host.is_empty() {
        if ssh_auth_type.to_lowercase().contains("key") {
            "key".to_string()
        } else {
            "password".to_string()
        }
    } else {
        String::new()
    };

    Some(ExternalConn {
        name: name.to_string(),
        db_type: parsed.db_type,
        host: parsed.host,
        port: parsed.port,
        user: user_final,
        password: parsed.password, // Usually empty for DataGrip
        database: parsed.database,
        env: None,
        group,
        ssl_mode: parsed.ssl_mode,
        ssl_ca: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh_host: ssh_host.to_string(),
        ssh_port,
        ssh_user: ssh_user.to_string(),
        ssh_auth_kind,
        ssh_password: String::new(),
        ssh_private_key: String::new(),
    })
}

// ---------------------------------------------------------------------------
// JDBC / URI Parsing Helper
// ---------------------------------------------------------------------------

struct ParsedUri {
    db_type: DbType,
    host: String,
    port: u16,
    user: String,
    password: String,
    database: String,
    ssl_mode: String,
}

fn parse_jdbc_url(raw: &str, driver_hint: &str) -> Option<ParsedUri> {
    let s = raw.trim();
    // Normalise jdbc prefix: e.g. jdbc:mysql://... -> mysql://...
    let (db_type, url_str) = if s.starts_with("jdbc:mysql:") || driver_hint.contains("mysql") {
        let stripped = s.strip_prefix("jdbc:mysql:").unwrap_or(s);
        (DbType::Mysql, stripped)
    } else if s.starts_with("jdbc:mariadb:") || driver_hint.contains("mariadb") {
        let stripped = s.strip_prefix("jdbc:mariadb:").unwrap_or(s);
        (DbType::Mysql, stripped)
    } else if s.starts_with("jdbc:redis:") || s.starts_with("redis:") || driver_hint.contains("redis") {
        let stripped = s
            .strip_prefix("jdbc:redis:")
            .or_else(|| s.strip_prefix("redis:"))
            .unwrap_or(s);
        (DbType::Redis, stripped)
    } else if s.starts_with("mysql://") {
        (DbType::Mysql, s.strip_prefix("mysql://").unwrap_or(s))
    } else {
        (DbType::Mysql, s)
    };

    // Ensure double slashes for standard URL parser
    let clean = if url_str.starts_with("//") {
        format!("http:{}", url_str)
    } else if url_str.starts_with('/') {
        format!("http:/{}", url_str)
    } else {
        format!("http://{}", url_str)
    };

    let parsed = url::Url::parse(&clean).ok()?;

    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let default_port = if db_type == DbType::Redis { 6379 } else { 3306 };
    let port = parsed.port().unwrap_or(default_port);
    let user = parsed.username().to_string();
    let password = parsed.password().unwrap_or("").to_string();

    // Database path: /dbname -> dbname
    let path = parsed.path().trim_start_matches('/');
    let database = path.to_string();

    // SSL query parameters: ?useSSL=true or sslMode=...
    let mut ssl_mode = "disabled".to_string();
    for (k, v) in parsed.query_pairs() {
        let k_lower = k.to_lowercase();
        let v_lower = v.to_lowercase();
        if k_lower == "usessl" {
            if v_lower == "true" || v_lower == "1" {
                ssl_mode = "required".to_string();
            }
        } else if k_lower == "sslmode" {
            if v_lower == "required" || v_lower == "verify_ca" || v_lower == "verify_identity" {
                ssl_mode = v_lower;
            }
        }
    }

    Some(ParsedUri {
        db_type,
        host,
        port,
        user,
        password,
        database,
        ssl_mode,
    })
}

// ---------------------------------------------------------------------------
// Raw URI List parser (one per line)
// ---------------------------------------------------------------------------

pub fn parse_raw_uris(text: &str) -> Result<Vec<ExternalConn>> {
    let mut conns = Vec::new();
    let mut idx = 1;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(parsed) = parse_jdbc_url(trimmed, "") {
            let user = if !parsed.user.is_empty() {
                parsed.user
            } else if parsed.db_type == DbType::Redis {
                "default".to_string()
            } else {
                "root".to_string()
            };

            let name = if !parsed.database.is_empty() {
                format!("{}-{}", parsed.database, parsed.host)
            } else {
                format!("conn-{}-{}", parsed.host, idx)
            };

            conns.push(ExternalConn {
                name,
                db_type: parsed.db_type,
                host: parsed.host,
                port: parsed.port,
                user,
                password: parsed.password,
                database: parsed.database,
                env: None,
                group: Some("连接串导入".to_string()),
                ssl_mode: parsed.ssl_mode,
                ssl_ca: String::new(),
                client_cert: String::new(),
                client_key: String::new(),
                ssh_host: String::new(),
                ssh_port: 22,
                ssh_user: String::new(),
                ssh_auth_kind: String::new(),
                ssh_password: String::new(),
                ssh_private_key: String::new(),
            });
            idx += 1;
        }
    }

    if conns.is_empty() {
        return Err(AppError::Msg("未解析出任何有效的数据库连接串".into()));
    }

    Ok(conns)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_navicat_xml() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Connections>
  <Connection ConnectionName="prod_db" ConnType="MYSQL" Host="192.168.1.50" Port="3306" UserName="admin" Password="" Database="shop_prod" SSL_Enabled="true" SSH_Host="jump.corp.com" SSH_Port="2222" SSH_UserName="ops" />
  <Group GroupName="测试集群">
    <Connection ConnectionName="redis_cache" ConnType="REDIS" Host="10.0.0.5" Port="6379" UserName="default" Password="" Database="" />
  </Group>
</Connections>"#;

        assert_eq!(detect_external_format(xml), Some(ExternalFormat::NavicatXml));
        let conns = parse_navicat_xml(xml).expect("parse navicat xml");
        assert_eq!(conns.len(), 2);

        let mysql = &conns[0];
        assert_eq!(mysql.name, "prod_db");
        assert_eq!(mysql.db_type, DbType::Mysql);
        assert_eq!(mysql.host, "192.168.1.50");
        assert_eq!(mysql.port, 3306);
        assert_eq!(mysql.user, "admin");
        assert_eq!(mysql.database, "shop_prod");
        assert_eq!(mysql.ssl_mode, "required");
        assert_eq!(mysql.ssh_host, "jump.corp.com");
        assert_eq!(mysql.ssh_port, 2222);
        assert_eq!(mysql.ssh_user, "ops");
        assert_eq!(mysql.group, Some("Navicat 导入".to_string()));

        let redis = &conns[1];
        assert_eq!(redis.name, "redis_cache");
        assert_eq!(redis.db_type, DbType::Redis);
        assert_eq!(redis.host, "10.0.0.5");
        assert_eq!(redis.port, 6379);
        assert_eq!(redis.group, Some("测试集群".to_string()));
    }

    #[test]
    fn test_parse_datagrip_xml() {
        let xml = r#"<component name="DataSourceManagerImpl" format="xml" multifile-model="true">
  <data-source source="LOCAL" name="local-mysql-8" uuid="12345">
    <driver-ref>mysql.8</driver-ref>
    <jdbc-url>jdbc:mysql://127.0.0.1:3306/my_database?useSSL=false&amp;serverTimezone=UTC</jdbc-url>
    <user-name>root</user-name>
    <group-name>微服务开发库</group-name>
    <ssh-properties enabled="true">
      <proxy-host>bastion.example.com</proxy-host>
      <proxy-port>22</proxy-port>
      <user>developer</user>
      <auth-type>PASSWORD</auth-type>
    </ssh-properties>
  </data-source>
</component>"#;

        assert_eq!(detect_external_format(xml), Some(ExternalFormat::DataGripXml));
        let conns = parse_datagrip_xml(xml).expect("parse datagrip xml");
        assert_eq!(conns.len(), 1);

        let c = &conns[0];
        assert_eq!(c.name, "local-mysql-8");
        assert_eq!(c.db_type, DbType::Mysql);
        assert_eq!(c.host, "127.0.0.1");
        assert_eq!(c.port, 3306);
        assert_eq!(c.database, "my_database");
        assert_eq!(c.user, "root");
        assert_eq!(c.group, Some("微服务开发库".to_string()));
        assert_eq!(c.ssh_host, "bastion.example.com");
        assert_eq!(c.ssh_port, 22);
        assert_eq!(c.ssh_user, "developer");
        assert_eq!(c.ssh_auth_kind, "password");
    }

    #[test]
    fn test_parse_raw_uris() {
        let uris = r#"
# Development databases
jdbc:mysql://192.168.0.10:3306/dev_app?useSSL=true
redis://:mypass@127.0.0.1:6379/1
"#;
        assert_eq!(detect_external_format(uris), Some(ExternalFormat::RawUriList));
        let conns = parse_raw_uris(uris).expect("parse raw uris");
        assert_eq!(conns.len(), 2);

        assert_eq!(conns[0].db_type, DbType::Mysql);
        assert_eq!(conns[0].host, "192.168.0.10");
        assert_eq!(conns[0].database, "dev_app");
        assert_eq!(conns[0].ssl_mode, "required");

        assert_eq!(conns[1].db_type, DbType::Redis);
        assert_eq!(conns[1].host, "127.0.0.1");
        assert_eq!(conns[1].port, 6379);
        assert_eq!(conns[1].password, "mypass");
    }

    #[test]
    fn test_parse_navicat_json() {
        let json_str = r#"[
  {
    "ConnectionName": "online_user_db",
    "ConnType": "MYSQL",
    "Host": "db.production.internal",
    "Port": 3306,
    "UserName": "reader",
    "Password": "",
    "Database": "user_center"
  }
]"#;
        assert_eq!(detect_external_format(json_str), Some(ExternalFormat::NavicatJson));
        let conns = parse_navicat_json(json_str).expect("parse navicat json");
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].name, "online_user_db");
        assert_eq!(conns[0].host, "db.production.internal");
        assert_eq!(conns[0].database, "user_center");
        assert_eq!(conns[0].group, Some("Navicat 导入".to_string()));
    }
}
