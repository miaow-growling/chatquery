use crate::db::connection::ConnectionConfig;
use crate::model::{DbScript, ScriptExecResult, ScriptType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 凭证动态更新载荷
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CredentialUpdate {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

/// Webhook 专用结构（如果 content 为 JSON）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WebhookConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_post")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// 自动提取新密码的 JSON 字段名或简易键（如 "password", "data.token"）
    #[serde(default)]
    pub extract_password_field: Option<String>,
}

fn default_post() -> String {
    "POST".to_string()
}

/// 执行脚本的主入口
pub async fn execute_script(
    script: &DbScript,
    conn: Option<&ConnectionConfig>,
    trigger: &str,
    error_msg: Option<&str>,
) -> (ScriptExecResult, Option<CredentialUpdate>) {
    let t0 = Instant::now();

    // 1. 构建注入的环境变量
    let mut envs = HashMap::new();
    if let Some(c) = conn {
        envs.insert("CQ_CONN_ID".to_string(), c.id.clone());
        envs.insert("CQ_CONN_NAME".to_string(), c.name.clone());
        envs.insert("CQ_CONN_HOST".to_string(), c.host.clone());
        envs.insert("CQ_CONN_PORT".to_string(), c.port.to_string());
        envs.insert("CQ_CONN_USER".to_string(), c.user.clone());
        envs.insert("CQ_CONN_DB".to_string(), c.database.clone());
        envs.insert(
            "CQ_CONN_TYPE".to_string(),
            match c.db_type {
                crate::db::connection::DbType::Mysql => "mysql".to_string(),
                crate::db::connection::DbType::Redis => "redis".to_string(),
            },
        );
    }
    envs.insert("CQ_TRIGGER_EVENT".to_string(), trigger.to_string());
    if let Some(err) = error_msg {
        envs.insert("CQ_ERROR_MESSAGE".to_string(), err.to_string());
    }

    // 合并用户自定义 env_vars
    if let Ok(custom) = serde_json::from_str::<HashMap<String, String>>(&script.env_vars) {
        for (k, v) in custom {
            envs.insert(k, v);
        }
    }

    // 2. 根据脚本类型分发执行
    let (success, exit_code, stdout, stderr) = match script.script_type {
        ScriptType::Shell => execute_shell(script, &envs).await,
        ScriptType::Webhook => execute_webhook(script, &envs).await,
        ScriptType::Python => execute_python(script, &envs).await,
        ScriptType::Javascript => execute_javascript(script, &envs).await,
    };

    let duration_ms = t0.elapsed().as_millis() as u64;

    // 3. 解析是否有动态凭证更新
    let cred_update = parse_credential_update(&stdout);
    let has_update = cred_update.is_some();
    let update_msg = if let Some(ref update) = cred_update {
        let mut parts = Vec::new();
        if update.password.is_some() {
            parts.push("已自动刷新数据库连接密码".to_string());
        }
        if let Some(ref u) = update.user {
            parts.push(format!("用户名更新为: {}", u));
        }
        Some(parts.join("，"))
    } else {
        None
    };

    let result = ScriptExecResult {
        success,
        exit_code,
        stdout,
        stderr,
        duration_ms,
        updated_credentials: has_update,
        update_message: update_msg,
    };

    (result, cred_update)
}

/// 变量替换辅助：将 {{KEY}} 或 ${KEY} 替换为对应值
fn substitute_vars(text: &str, envs: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (k, v) in envs {
        out = out.replace(&format!("{{{{{}}}}}", k), v);
        out = out.replace(&format!("${{{}}}", k), v);
    }
    out
}

/// 执行系统原生 Shell
async fn execute_shell(script: &DbScript, envs: &HashMap<String, String>) -> (bool, i32, String, String) {
    let timeout_secs = script.timeout_secs.max(1);
    let content = substitute_vars(&script.content, envs);

    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg(&content);
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut c = tokio::process::Command::new(shell);
        c.arg("-c").arg(&content);
        c
    };

    cmd.envs(envs);

    let res = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;
    match res {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let code = output.status.code().unwrap_or(if output.status.success() { 0 } else { 1 });
            (output.status.success(), code, stdout, stderr)
        }
        Ok(Err(e)) => (false, -1, String::new(), format!("执行失败: {}", e)),
        Err(_) => (false, -2, String::new(), format!("脚本执行超时（超过 {} 秒限制）", timeout_secs)),
    }
}

/// 执行 HTTP Webhook 模式
async fn execute_webhook(script: &DbScript, envs: &HashMap<String, String>) -> (bool, i32, String, String) {
    let timeout_secs = script.timeout_secs.max(1);
    let trimmed = script.content.trim();

    // 尝试解析为 JSON 配置，否则直接作为普通 URL
    let (url, method, headers, body, extract_key) = if trimmed.starts_with('{') {
        if let Ok(cfg) = serde_json::from_str::<WebhookConfig>(trimmed) {
            (
                substitute_vars(&cfg.url, envs),
                cfg.method.to_uppercase(),
                cfg.headers,
                cfg.body.map(|b| substitute_vars(&b, envs)),
                cfg.extract_password_field,
            )
        } else {
            (substitute_vars(trimmed, envs), "POST".to_string(), HashMap::new(), None, None)
        }
    } else {
        (substitute_vars(trimmed, envs), "POST".to_string(), HashMap::new(), None, None)
    };

    if url.is_empty() {
        return (false, -1, String::new(), "Webhook URL 不能为空".to_string());
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, -1, String::new(), format!("初始化 HTTP 客户端失败: {}", e)),
    };

    let req_builder = match method.as_str() {
        "GET" => client.get(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.post(&url),
    };

    let mut req_builder = req_builder;
    for (k, v) in headers {
        req_builder = req_builder.header(k, substitute_vars(&v, envs));
    }

    if let Some(b) = body {
        if b.trim().starts_with('{') || b.trim().starts_with('[') {
            req_builder = req_builder.header("Content-Type", "application/json").body(b);
        } else {
            req_builder = req_builder.body(b);
        }
    }

    match req_builder.send().await {
        Ok(resp) => {
            let status = resp.status();
            let is_success = status.is_success();
            let status_code = status.as_u16() as i32;
            let resp_text = resp.text().await.unwrap_or_default();

            // 若明确配置了提取新密码字段，且返回为 JSON
            let mut final_stdout = format!("[HTTP {}]\n{}", status_code, resp_text);
            if is_success {
                if let Some(target_key) = extract_key {
                    let trimmed_key = target_key.trim();
                    if !trimmed_key.is_empty() {
                        if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&resp_text) {
                            if let Some(extracted) = json_val
                                .pointer(&format!("/{}", trimmed_key.replace('.', "/")))
                                .or_else(|| json_val.get(trimmed_key))
                            {
                                if let Some(pass_str) = extracted.as_str() {
                                    final_stdout.push_str(&format!(
                                        "\nCQ_UPDATE_CONNECTION: {{\"password\": \"{}\"}}\n",
                                        pass_str
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            if is_success {
                (true, status_code, final_stdout, String::new())
            } else {
                (false, status_code, final_stdout, format!("HTTP 请求失败，状态码: {}", status_code))
            }
        }
        Err(e) => (false, -1, String::new(), format!("HTTP 请求异常: {}", e)),
    }
}

/// 执行 Python 脚本
async fn execute_python(script: &DbScript, envs: &HashMap<String, String>) -> (bool, i32, String, String) {
    let timeout_secs = script.timeout_secs.max(1);
    let content = substitute_vars(&script.content, envs);

    // 写入安全临时文件执行，规避命令行引号转义
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("cq_script_{}.py", crate::db::container::gen_id("py")));
    if let Err(e) = std::fs::write(&temp_file, content) {
        return (false, -1, String::new(), format!("写入临时 Python 脚本失败: {}", e));
    }

    #[cfg(windows)]
    let python_cmd = "python";
    #[cfg(not(windows))]
    let python_cmd = "python3";

    let mut cmd = tokio::process::Command::new(python_cmd);
    cmd.arg(&temp_file);
    cmd.envs(envs);

    let res = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;
    let _ = std::fs::remove_file(&temp_file);

    match res {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let code = output.status.code().unwrap_or(if output.status.success() { 0 } else { 1 });
            (output.status.success(), code, stdout, stderr)
        }
        Ok(Err(e)) => (
            false,
            -1,
            String::new(),
            format!("未找到 Python 解释器或执行失败: {}. 请确认系统是否已安装 Python 并在 PATH 中", e),
        ),
        Err(_) => (false, -2, String::new(), format!("Python 脚本执行超时（超过 {} 秒）", timeout_secs)),
    }
}

/// 执行 JavaScript 脚本 (Node.js)
async fn execute_javascript(script: &DbScript, envs: &HashMap<String, String>) -> (bool, i32, String, String) {
    let timeout_secs = script.timeout_secs.max(1);
    let content = substitute_vars(&script.content, envs);

    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("cq_script_{}.js", crate::db::container::gen_id("js")));
    if let Err(e) = std::fs::write(&temp_file, content) {
        return (false, -1, String::new(), format!("写入临时 JS 脚本失败: {}", e));
    }

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&temp_file);
    cmd.envs(envs);

    let res = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await;
    let _ = std::fs::remove_file(&temp_file);

    match res {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let code = output.status.code().unwrap_or(if output.status.success() { 0 } else { 1 });
            (output.status.success(), code, stdout, stderr)
        }
        Ok(Err(e)) => (
            false,
            -1,
            String::new(),
            format!("未找到 Node 运行时或执行失败: {}. 推荐改用 Shell 或 HTTP Webhook 模式", e),
        ),
        Err(_) => (false, -2, String::new(), format!("JS 脚本执行超时（超过 {} 秒）", timeout_secs)),
    }
}

/// 从标准输出中解析 CQ_UPDATE_CONNECTION 协议
fn parse_credential_update(stdout: &str) -> Option<CredentialUpdate> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("CQ_UPDATE_CONNECTION:") {
            if let Ok(update) = serde_json::from_str::<CredentialUpdate>(rest.trim()) {
                return Some(update);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_credential_update() {
        let stdout = "Running renewal script...\nToken refreshed successfully\nCQ_UPDATE_CONNECTION: {\"password\": \"NewSecretPass!\", \"user\": \"app_user\"}\nDone.\n";
        let update = parse_credential_update(stdout).expect("should find update");
        assert_eq!(update.password.as_deref(), Some("NewSecretPass!"));
        assert_eq!(update.user.as_deref(), Some("app_user"));

        let none_stdout = "Just normal logs without tag\n";
        assert!(parse_credential_update(none_stdout).is_none());
    }

    #[test]
    fn test_substitute_vars() {
        let mut envs = HashMap::new();
        envs.insert("CQ_CONN_HOST".to_string(), "10.0.0.1".to_string());
        envs.insert("CQ_CONN_USER".to_string(), "root".to_string());

        let tpl = "curl http://{{CQ_CONN_HOST}}:8080/renew?user=${CQ_CONN_USER}";
        let res = substitute_vars(tpl, &envs);
        assert_eq!(res, "curl http://10.0.0.1:8080/renew?user=root");
    }

    #[tokio::test]
    async fn test_execute_shell_basic() {
        let script = DbScript {
            id: "test_sh".to_string(),
            name: "echo test".to_string(),
            description: "".to_string(),
            enabled: true,
            script_type: ScriptType::Shell,
            content: "echo \"hello-cq\"".to_string(),
            timeout_secs: 10,
            env_vars: "{}".to_string(),
            bound_conn_ids: vec![],
            trigger_on_error: false,
            error_pattern: "".to_string(),
            auto_retry_query: true,
            created: 0,
            updated: 0,
        };

        let (result, _) = execute_script(&script, None, "test", None).await;
        assert!(result.success);
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello-cq"));
    }

    #[test]
    fn test_webhook_config_optional_extract() {
        // 无 extract_password_field 时，不提取凭证
        let cfg_pure = r#"{
            "url": "https://api.internal/renew",
            "method": "POST"
        }"#;
        let parsed: WebhookConfig = serde_json::from_str(cfg_pure).unwrap();
        assert!(parsed.extract_password_field.is_none());

        // 显式配置 extract_password_field 时，正常解析
        let cfg_with_key = r#"{
            "url": "https://api.internal/renew",
            "method": "POST",
            "extract_password_field": "data.new_password"
        }"#;
        let parsed2: WebhookConfig = serde_json::from_str(cfg_with_key).unwrap();
        assert_eq!(parsed2.extract_password_field.as_deref(), Some("data.new_password"));
    }
}

