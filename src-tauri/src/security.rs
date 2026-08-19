use std::path::{Path, PathBuf};

/// Validate that a database path is within allowed directories.
///
/// Strategy: only allow files under ~/.local/share/opencode/
/// or the project's test-data/ directory.
/// This prevents path traversal attacks.
pub fn validate_db_path(path_str: &str) -> Result<PathBuf, String> {
    if path_str.is_empty() {
        return Err("数据库路径为空".into());
    }

    let home = dirs::home_dir().ok_or("无法获取家目录路径")?;
    let cwd = std::env::current_dir().unwrap_or_default();

    let allowed_roots = [
        home.join(".local/share/opencode"),
        cwd.join("test-data"),
    ];

    let path = Path::new(path_str);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        // Resolve relative paths against CWD
        cwd.join(path)
    };

    let canonical = abs
        .canonicalize()
        .map_err(|e| format!("路径无法解析: {}", e))?;

    let inside = allowed_roots
        .iter()
        .any(|root| canonical.starts_with(root));

    if !inside {
        return Err("不允许打开该目录下的数据库文件".into());
    }

    Ok(canonical)
}

/// Resolve the canonical database snapshot currently held by the server.
///
/// Renderer-supplied paths must continue to use `validate_db_path`. This is
/// deliberately narrower: shell reveal receives its path from `DbState`, which
/// is populated only by `db::open`, and therefore may also reveal a direct file
/// inside OpenCode-W's own canonical backup directory after a restore.
pub fn resolve_server_snapshot_path(path_str: &str) -> Result<PathBuf, String> {
    if let Ok(path) = validate_db_path(path_str) {
        return Ok(path);
    }

    let home = dirs::home_dir().ok_or("无法获取家目录路径")?;
    let backup_root = home.join(".opencode-w").join("backups").canonicalize()
        .map_err(|e| format!("备份目录无法解析: {}", e))?;
    let snapshot = Path::new(path_str)
        .canonicalize()
        .map_err(|e| format!("路径无法解析: {}", e))?;

    if snapshot.parent() == Some(backup_root.as_path()) {
        Ok(snapshot)
    } else {
        Err("不允许打开该目录下的数据库文件".into())
    }
}

/// Validate database file extension.
/// Only allows: .db, .sqlite, .sqlite3
pub fn validate_db_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "db" | "sqlite" | "sqlite3" => Ok(()),
        _ => {
            let filename = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown");
            Err(format!(
                "数据库扩展名不允许（仅接受 .db / .sqlite / .sqlite3）：{}",
                filename
            ))
        }
    }
}

/// Validate a URL used by shell:open-external.
/// Only allows http: and https: protocols.
pub fn validate_shell_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("链接为空".into());
    }

    let parsed = url::Url::parse(url).map_err(|_| String::from("链接格式无效"))?;

    match parsed.scheme() {
        "http" | "https" => Ok(()),
        scheme => Err(format!("不支持的协议: {}", scheme)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_db_extension_ok() {
        assert!(validate_db_extension(Path::new("test.db")).is_ok());
        assert!(validate_db_extension(Path::new("test.sqlite")).is_ok());
        assert!(validate_db_extension(Path::new("test.sqlite3")).is_ok());
    }

    #[test]
    fn test_validate_db_extension_reject() {
        assert!(validate_db_extension(Path::new("test.txt")).is_err());
        assert!(validate_db_extension(Path::new("test")).is_err());
        assert!(validate_db_extension(Path::new("test.exe")).is_err());
    }

    #[test]
    fn test_validate_shell_url_ok() {
        assert!(validate_shell_url("https://example.com").is_ok());
        assert!(validate_shell_url("http://localhost:5173").is_ok());
    }

    #[test]
    fn test_validate_shell_url_reject() {
        assert!(validate_shell_url("file:///etc/passwd").is_err());
        assert!(validate_shell_url("javascript:alert(1)").is_err());
        assert!(validate_shell_url("").is_err());
    }
}
