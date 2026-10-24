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

    let allowed_roots = [home.join(".local/share/opencode"), cwd.join("test-data")];

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

    // 允许根目录也必须先 canonicalize 再比较：
    // Windows 上 `canonicalize` 返回 **verbatim** 路径 `\\?\D:\a\...\test-data`，
    // 而 allowed_roots 是未解析的普通路径 `D:\a\...\test-data`；
    // `Path::starts_with` 逐组件比较，第一个组件
    // （`Prefix(VerbatimDisk)` vs `Prefix(Disk)`）就不同 → 永远 false，
    // 导致「打开数据库」「打开所在目录」在 Windows 上全部失效。
    //
    // 根目录不存在时回退到原值：它下面不可能存在可打开的文件。
    let inside = allowed_roots.iter().any(|root| {
        let root = root.canonicalize().unwrap_or_else(|_| root.clone());
        path_is_within(&canonical.to_string_lossy(), &root.to_string_lossy())
    });

    if !inside {
        return Err("不允许打开该目录下的数据库文件".into());
    }

    Ok(canonical)
}

/// 归一化后的可比较路径。
///
/// `Path::starts_with` 处理不了下面三个 Windows 差异，因此比较一律基于
/// 归一化字符串而不是 `Path` 组件：
///
/// 1. `Path::canonicalize` 在 Windows 上返回 **verbatim** 路径
///    `\\?\D:\a\test-data`，而允许根目录是普通路径 `D:\a\test-data`；
/// 2. Windows 路径**大小写不敏感**；
/// 3. Windows 同时接受 `\` 与 `/` 作为分隔符。
///
/// Unix 语义保持不变：**只有 Windows 风格路径**（盘符 / UNC）才忽略大小写，
/// 普通 Unix 路径仍然大小写敏感。
#[derive(Debug, PartialEq, Eq)]
struct ComparablePath {
    /// 是否绝对路径（有盘符或根）。
    absolute: bool,
    /// 是否 Windows 风格路径（盘符 / UNC）→ 比较时忽略大小写。
    windows_like: bool,
    /// 路径锚点：大写盘符（`C:`）或 UNC 标记（`//`）。
    anchor: Option<String>,
    /// 路径组件（按分隔符切分，已去掉空段与 `.`）。
    components: Vec<String>,
}

/// 把路径字符串归一化成可比较的结构（纯函数，与平台无关）。
fn comparable_path(raw: &str) -> ComparablePath {
    // Windows 的两种分隔符统一成 `/`。
    let unified = raw.replace('\\', "/");

    // 去掉 Windows verbatim 前缀：
    // `\\?\C:\x` → `C:/x`，`\\?\UNC\srv\share` → `//srv/share`。
    let stripped = match unified.strip_prefix("//?/") {
        Some(rest) => match rest.strip_prefix("UNC/") {
            Some(unc) => format!("//{unc}"),
            None => rest.to_string(),
        },
        None => unified,
    };

    // 盘符：Windows 绝对路径的锚点。
    let bytes = stripped.as_bytes();
    let (drive, rest) = if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        (Some(stripped[..2].to_ascii_uppercase()), stripped[2..].to_string())
    } else {
        (None, stripped.clone())
    };

    // UNC 路径（`//server/share/...`）。
    let unc = drive.is_none() && stripped.starts_with("//");
    let absolute = drive.is_some() || stripped.starts_with('/');

    ComparablePath {
        absolute,
        windows_like: drive.is_some() || unc,
        anchor: drive.or_else(|| if unc { Some("//".to_string()) } else { None }),
        components: rest
            .split('/')
            .filter(|component| !component.is_empty() && *component != ".")
            .map(|component| component.to_string())
            .collect(),
    }
}

/// 判断 `candidate` 是否位于 `root` 之内（纯函数，与平台无关）。
///
/// 两侧都会先归一化，因此 Windows 的 verbatim 前缀、大小写差异、混合分隔符
/// 都不影响结果；目录边界仍然严格：`test-data` 不会匹配 `test-data-evil`，
/// 不同盘符（`C:` / `D:`）、不同 UNC 主机同样互不包含。
///
/// `candidate` 必须是绝对路径且不含 `..`：调用方传进来的应当是
/// `canonicalize` 之后的路径，这里再挡一次是为了避免误用。
fn path_is_within(candidate: &str, root: &str) -> bool {
    let candidate = comparable_path(candidate);
    let root = comparable_path(root);

    // 相对路径不可能位于绝对根目录之内（反之亦然）。
    if !candidate.absolute || !root.absolute {
        return false;
    }
    // Windows 风格与 Unix 风格路径属于不同的命名空间，不可混比。
    if candidate.windows_like != root.windows_like {
        return false;
    }
    // 不同盘符 / 不同 UNC 主机不是同一个目录。
    if candidate.anchor != root.anchor {
        return false;
    }
    // 候选路径里还留着 `..`：没有解析过，不能证明它在根目录之内。
    if candidate.components.iter().any(|component| component == "..") {
        return false;
    }
    if candidate.components.len() < root.components.len() {
        return false;
    }

    let case_insensitive = root.windows_like;
    let equal = |left: &str, right: &str| {
        if case_insensitive {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };

    candidate
        .components
        .iter()
        .zip(root.components.iter())
        .all(|(left, right)| equal(left, right))
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
    resolve_server_snapshot_path_in_backup_root(path_str, &home.join(".opencode-w").join("backups"))
}

pub fn resolve_server_snapshot_path_in_backup_root(
    path_str: &str,
    backup_root: &Path,
) -> Result<PathBuf, String> {
    let backup_root = backup_root
        .canonicalize()
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
            let filename = path
                .file_name()
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

    // ── 路径包含判定（纯函数，跨平台可测）────────────────────────────
    //
    // 这些用例全部用 **Windows 风格字符串**书写，因此在 macOS / Linux 上
    // 也能覆盖 Windows 的 verbatim 前缀、大小写与目录边界行为。

    #[test]
    fn path_within_strips_the_windows_verbatim_prefix() {
        // `\\?\D:\a\test-data\x.db` 与 `D:\a\test-data` 是同一个目录。
        assert!(path_is_within(
            r"\\?\D:\a\test-data\x.db",
            r"D:\a\test-data"
        ));
        // 两侧都带 verbatim 前缀同样成立。
        assert!(path_is_within(
            r"\\?\D:\a\test-data\x.db",
            r"\\?\D:\a\test-data"
        ));
        // 根目录带前缀、候选路径不带，也成立。
        assert!(path_is_within(r"D:\a\test-data\x.db", r"\\?\D:\a\test-data"));
        // UNC 的 verbatim 形式与普通 UNC 形式等价。
        assert!(path_is_within(
            r"\\?\UNC\srv\share\x.db",
            r"\\srv\share"
        ));
    }

    #[test]
    fn path_within_ignores_case_only_on_windows_style_paths() {
        assert!(path_is_within(r"\\?\D:\A\TEST-DATA\x.db", r"d:\a\test-data"));
        // Unix 路径大小写敏感：不得因为忽略大小写而放宽边界。
        assert!(!path_is_within("/tmp/Test-Data/x.db", "/tmp/test-data"));
    }

    #[test]
    fn path_within_respects_directory_boundaries() {
        // `test-data-evil` 是另一个目录，不能被 `test-data` 覆盖。
        assert!(!path_is_within(
            r"\\?\D:\a\test-data-evil\x.db",
            r"D:\a\test-data"
        ));
        assert!(!path_is_within(
            r"D:\a\test-data-evil\x.db",
            r"\\?\D:\a\test-data"
        ));
        // 前缀相同但组件边界不同的情况也要拒绝。
        assert!(!path_is_within(r"D:\a\test-data2\x.db", r"D:\a\test-data"));
    }

    #[test]
    fn path_within_rejects_other_drives_roots_and_relative_paths() {
        // 不同盘符不是同一个目录。
        assert!(!path_is_within(r"\\?\E:\a\test-data\x.db", r"D:\a\test-data"));
        // 根目录之外的文件必须被拒。
        assert!(!path_is_within("/tmp/outside.db", "/tmp/test-data"));
        assert!(!path_is_within(r"\\?\D:\other\x.db", r"D:\a\test-data"));
        // UNC 主机不同。
        assert!(!path_is_within(r"\\?\UNC\other\share\x.db", r"\\srv\share"));
        // 相对路径不在绝对根目录之内。
        assert!(!path_is_within("test-data/x.db", "/tmp/test-data"));
        // 绝对根目录不能被相对候选路径命中。
        assert!(!path_is_within("/tmp/test-data/x.db", "test-data"));
    }

    #[test]
    fn path_within_rejects_unresolved_parent_segments() {
        // 没有 canonicalize 的 `..` 不能证明在根目录之内。
        assert!(!path_is_within(
            "/tmp/test-data/../outside.db",
            "/tmp/test-data"
        ));
        assert!(!path_is_within(
            r"\\?\D:\a\test-data\..\outside.db",
            r"D:\a\test-data"
        ));
    }

    #[test]
    fn path_within_matches_the_exact_windows_ci_scenario() {
        // CI（windows-latest）上失败的真实形态：
        // `canonicalize` 返回 verbatim 路径，允许根目录是未 canonicalize 的普通路径。
        let root = r"D:\a\OpenCode-W\OpenCode-W\OpenCode-W\src-tauri\test-data";
        let canonical =
            r"\\?\D:\a\OpenCode-W\OpenCode-W\OpenCode-W\src-tauri\test-data\reveal-path-123.db";
        assert!(path_is_within(canonical, root));
        // 根目录也 canonicalize 过（同样带 verbatim 前缀）时同样成立。
        assert!(path_is_within(
            canonical,
            r"\\?\D:\a\OpenCode-W\OpenCode-W\OpenCode-W\src-tauri\test-data"
        ));
        // 兄弟目录仍然被拒：不得因为剥前缀而放宽目录边界。
        assert!(!path_is_within(
            r"\\?\D:\a\OpenCode-W\OpenCode-W\OpenCode-W\src-tauri\test-data-evil\x.db",
            root
        ));
    }

    #[test]
    fn path_within_accepts_a_path_inside_the_root_on_unix() {
        assert!(path_is_within(
            "/Users/dev/project/test-data/x.db",
            "/Users/dev/project/test-data"
        ));
        assert!(path_is_within(
            "/Users/dev/project/test-data",
            "/Users/dev/project/test-data"
        ));
    }
}
