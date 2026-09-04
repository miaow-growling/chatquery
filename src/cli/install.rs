use std::path::{Path, PathBuf};

/// 确保在用户的 `~/.local/bin/chatquery` 存在指向当前二进制的软链接。
/// 仅在 Unix (macOS / Linux) 环境下生效，Windows 环境静默返回 Ok(None)。
pub fn ensure_cli_symlink() -> std::io::Result<Option<PathBuf>> {
    #[cfg(unix)]
    {
        let home = match std::env::var_os("HOME") {
            Some(h) => PathBuf::from(h),
            None => return Ok(None),
        };

        let bin_dir = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin_dir)?;
        let symlink_path = bin_dir.join("chatquery");
        let current_exe = std::env::current_exe()?;
        if current_exe.starts_with("/Volumes") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "应用仍位于临时磁盘映像中，请先安装到 Applications 后再安装 CLI",
            ));
        }

        if let Ok(target) = std::fs::read_link(&symlink_path) {
            if target == current_exe {
                return Ok(Some(symlink_path));
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} 已指向其他程序，未自动覆盖", symlink_path.display()),
            ));
        }
        if symlink_path.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("{} 已存在普通文件，未自动覆盖", symlink_path.display()),
            ));
        }

        std::os::unix::fs::symlink(&current_exe, &symlink_path)?;
        Ok(Some(symlink_path))
    }

    #[cfg(not(unix))]
    {
        Ok(None)
    }
}

/// 检查当前 PATH 环境变量是否包含指定的目录
pub fn is_dir_in_path(dir: &Path) -> bool {
    if let Some(path_os) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&path_os) {
            if p == dir {
                return true;
            }
        }
    }
    false
}
