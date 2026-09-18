use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 校验是否为合法的 Git 仓库地址（只支持 Git 协议）
pub fn validate_git_url(url: &str) -> Result<()> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::Msg("Git 仓库地址不能为空".into()));
    }
    let is_valid = trimmed.starts_with("git@")
        || trimmed.starts_with("ssh://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("git://")
        || trimmed.starts_with("file://");

    if !is_valid {
        return Err(AppError::Msg(
            "Git 仓库地址格式不正确，仅支持 Git 协议地址（例如 git@github.com:user/repo.git 或 https://github.com/user/repo.git）".into(),
        ));
    }
    Ok(())
}

/// 执行底层 git 命令，配置安全环境变量防止交互式提示挂起
pub fn run_git_cmd(args: &[&str], cwd: Option<&Path>) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // 防止因缺少凭据在后台无限阻塞等待终端输入
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // 批处理模式，首次连接时自动信任指纹但绝不阻塞
    cmd.env(
        "GIT_SSH_COMMAND",
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    );

    let output = cmd
        .output()
        .map_err(|e| AppError::Msg(format!("执行 git 命令失败: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(AppError::Msg(format!("Git 操作异常: {}", msg)));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 检查本机是否已安装 Git
pub fn check_git_installed() -> Result<String> {
    let ver = run_git_cmd(&["--version"], None).map_err(|_| {
        AppError::Msg(
            "未检测到系统 Git 命令，请确保本机已安装 Git 并配置到系统 PATH 环境变量中".into(),
        )
    })?;
    Ok(ver)
}

/// 测试指定 Git 仓库的连通性与权限 (使用 ls-remote)
pub fn test_git_remote(git_url: &str) -> Result<String> {
    validate_git_url(git_url)?;
    check_git_installed()?;

    let res = run_git_cmd(&["ls-remote", "--heads", git_url.trim()], None);
    match res {
        Ok(_) => Ok("Git 仓库连接成功，访问权限校验通过".into()),
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("Permission denied") || err_str.contains("Authentication failed") {
                Err(AppError::Msg(format!(
                    "Git 鉴权失败：无权访问该仓库。若使用 SSH 地址请检查本地 ~/.ssh/ 密钥配置；若使用 HTTPS 请确认凭据助手配置。\n详情: {}",
                    err_str
                )))
            } else if err_str.contains("Repository not found") || err_str.contains("Could not resolve host") {
                Err(AppError::Msg(format!(
                    "Git 仓库不存在或网络不可达，请检查仓库地址是否正确。\n详情: {}",
                    err_str
                )))
            } else {
                Err(AppError::Msg(format!("Git 连通性测试失败: {}", err_str)))
            }
        }
    }
}

/// 本地 Git 备份仓库目录
pub fn get_sync_repo_dir() -> PathBuf {
    crate::crypto::config_dir().join("git_sync_repo")
}

/// 准备本地备份仓库（克隆或初始化，并绑定 remote origin）
pub fn prepare_repo(repo_dir: &Path, git_url: &str) -> Result<()> {
    validate_git_url(git_url)?;
    check_git_installed()?;

    let git_dir = repo_dir.join(".git");
    if git_dir.exists() {
        // 仓库已存在，检查并更新 remote origin
        let cur_url = run_git_cmd(&["remote", "get-url", "origin"], Some(repo_dir)).unwrap_or_default();
        if cur_url.trim() != git_url.trim() {
            let _ = run_git_cmd(&["remote", "set-url", "origin", git_url.trim()], Some(repo_dir));
        }
    } else {
        std::fs::create_dir_all(repo_dir)?;
        // 尝试克隆远端仓库
        let clone_res = run_git_cmd(&["clone", git_url.trim(), "."], Some(repo_dir));
        if clone_res.is_err() && !git_dir.exists() {
            // 如果克隆失败且没有生成 .git（通常因为远端是全新空仓库），则本地初始化并关联 remote
            run_git_cmd(&["init"], Some(repo_dir))?;
            let _ = run_git_cmd(&["remote", "add", "origin", git_url.trim()], Some(repo_dir));
            let _ = run_git_cmd(&["branch", "-M", "main"], Some(repo_dir));
        }
    }

    // 确保有基本的 commit 签名信息，防止在无全局 git 配置的机器上 commit 报错
    let name_ok = run_git_cmd(&["config", "user.name"], Some(repo_dir)).is_ok();
    if !name_ok {
        let _ = run_git_cmd(&["config", "user.name", "ChatQuery Sync"], Some(repo_dir));
    }
    let email_ok = run_git_cmd(&["config", "user.email"], Some(repo_dir)).is_ok();
    if !email_ok {
        let _ = run_git_cmd(
            &["config", "user.email", "sync@chatquery.local"],
            Some(repo_dir),
        );
    }

    Ok(())
}

/// 拉取最新远端变动
pub fn pull_repo(repo_dir: &Path) -> Result<()> {
    // 先获取
    let _ = run_git_cmd(&["fetch", "origin"], Some(repo_dir));
    // 尝试 rebase pull
    let _ = run_git_cmd(&["pull", "--rebase", "origin", "main"], Some(repo_dir));
    Ok(())
}

/// 提交并推送到远端 Git 仓库。返回值：true 表示有变动并成功推送，false 表示数据无变化
pub fn push_backup(repo_dir: &Path, commit_msg: &str) -> Result<bool> {
    run_git_cmd(&["add", "-A"], Some(repo_dir))?;

    let status = run_git_cmd(&["status", "--porcelain"], Some(repo_dir))?;
    if status.trim().is_empty() {
        // 没有内容修改
        return Ok(false);
    }

    run_git_cmd(&["commit", "-m", commit_msg], Some(repo_dir))?;

    // 推送至远端（优先推送到 HEAD）
    run_git_cmd(&["push", "-u", "origin", "HEAD"], Some(repo_dir)).or_else(|_| {
        run_git_cmd(&["push", "-u", "origin", "main"], Some(repo_dir))
    })?;

    Ok(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub timestamp: i64,
    pub message: String,
}

/// 列出最近 N 条提交历史
pub fn list_commits(repo_dir: &Path, limit: usize) -> Result<Vec<GitCommitInfo>> {
    let git_dir = repo_dir.join(".git");
    if !git_dir.exists() {
        return Ok(Vec::new());
    }

    let _ = run_git_cmd(&["fetch", "origin"], Some(repo_dir));

    let fmt = "--pretty=format:%H|%h|%at|%s";
    let limit_str = format!("-n{}", limit);
    let output = run_git_cmd(&["log", &limit_str, fmt], Some(repo_dir));
    let raw = match output {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 4 {
            let hash = parts[0].trim().to_string();
            let short_hash = parts[1].trim().to_string();
            let timestamp = parts[2].trim().parse::<i64>().unwrap_or(0);
            let message = parts[3..].join("|").trim().to_string();
            out.push(GitCommitInfo {
                hash,
                short_hash,
                timestamp,
                message,
            });
        }
    }
    Ok(out)
}

/// 读取指定 Commit 中的特定文件内容（免 checkout，零状态污染）
pub fn show_file_at_commit(repo_dir: &Path, commit_hash: &str, file_name: &str) -> Result<String> {
    let target = format!("{}:{}", commit_hash.trim(), file_name.trim());
    run_git_cmd(&["show", &target], Some(repo_dir))
}

