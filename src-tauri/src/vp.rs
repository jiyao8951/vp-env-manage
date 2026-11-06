//! Vite+ (`vp`) CLI 的封装：自动定位可执行文件并执行命令。
//! 命令参考：https://viteplus.dev/guide/env

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 在 Windows 上隐藏子进程的控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn new_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// 读取类命令（current / list / which / print / doctor / setup…）超时
pub const TIMEOUT_DEFAULT: Duration = Duration::from_secs(30);
/// 需要访问 registry 的命令（list-remote）超时
pub const TIMEOUT_REMOTE: Duration = Duration::from_secs(60);
/// 会联网下载或批量删除的命令（install / uninstall / pin / clean / exec）超时
pub const TIMEOUT_LONG: Duration = Duration::from_secs(300);
/// 安装 / 升级 vp 本身可能包含完整 Node 运行时与依赖下载，给足时间
pub const TIMEOUT_BOOTSTRAP: Duration = Duration::from_secs(900);
/// `vp install`：按项目 package.json 安装依赖，可能包含编译，给 10 分钟
pub const TIMEOUT_PROJECT: Duration = Duration::from_secs(600);

/// 环境模块要求的最低 Vite+ 版本：1.5.0 起 `vp env doctor` 发现问题会以退出码 1 结束，
/// 客户端据此判定健康状态；更早的版本可能把失败当成成功。
pub const MIN_VERSION: &str = "1.5.0";
const MIN_VERSION_TUPLE: (u64, u64, u64) = (1, 5, 0);

/// 环境操作互斥：install / uninstall / pin / default / clean / setup 等
/// 会改环境的命令共用一把锁，重复操作直接拒绝，避免并发写同一个安装目录。
static ENV_OP_LOCK: Mutex<()> = Mutex::new(());

pub fn try_lock_env() -> Result<MutexGuard<'static, ()>, String> {
    ENV_OP_LOCK
        .try_lock()
        .map_err(|_| "已有环境操作正在进行，请等待它结束再试。".to_string())
}

/// 启动自检结果，前端据此展示环境是否可用、是否发生过安装 / 升级
#[derive(Debug, Clone, Serialize)]
pub struct EnsureResult {
    pub ok: bool,
    pub compliant: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub previous_version: Option<String>,
    pub installed: bool,
    pub upgraded: bool,
    pub actions: Vec<String>,
    pub log: String,
    pub error: Option<String>,
    /// 多副本 / 版本不一致等非致命提示
    pub warnings: Vec<String>,
}

impl EnsureResult {
    fn new() -> Self {
        Self {
            ok: false,
            compliant: false,
            path: None,
            version: None,
            previous_version: None,
            installed: false,
            upgraded: false,
            actions: Vec::new(),
            log: String::new(),
            error: None,
            warnings: Vec::new(),
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        let mut out = Self::new();
        out.error = Some(message.into());
        out
    }
}

/// 从 `vp --version` 的输出里取出干净的版本号，例如 `vp v1.4.0` → `1.4.0`
pub fn clean_version(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    line.split_whitespace()
        .rev()
        .find(|t| {
            t.trim_start_matches('v')
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
        })
        .unwrap_or(line)
        .trim_start_matches('v')
        .to_string()
}

/// 解析主 / 次 / 补丁号；缺少的部分按 0 处理
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let clean = clean_version(text);
    let mut parts = clean.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    Some((major, minor, patch))
}

pub fn is_supported(text: &str) -> bool {
    parse_version(text).is_some_and(|v| v >= MIN_VERSION_TUPLE)
}

/// 判断 `--version` 输出是否真的来自 Vite+，而不是别的恰好也打印版本号的程序。
/// `vp --version` 会输出 `vp v1.4.0`（后面还带 Tools / Environment 列表）。
pub fn version_identity(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("vite-plus") || lower.contains("vite+ ") {
        return true;
    }
    text.split_whitespace().any(|token| {
        let cleaned: String = token
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        cleaned.eq_ignore_ascii_case("vp") || cleaned.eq_ignore_ascii_case("vite-plus")
    })
}

/// 超时后终止进程树。返回是否执行成功（失败时进程可能仍在运行）
fn kill_tree(pid: u32) -> bool {
    let mut cmd = if cfg!(windows) {
        let mut c = new_command(Path::new("taskkill"));
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    } else {
        let mut c = new_command(Path::new("kill"));
        c.args(["-9", &pid.to_string()]);
        c
    };
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Windows 下按 PATHEXT 的顺序匹配可执行入口：`.COM` > `.EXE` > `.BAT` > `.CMD`。
/// 不带后缀的 `npm` 是 Unix shell 脚本，cmd / PowerShell 都无法直接启动，
/// 不能与同目录的 `npm.cmd` 一起算作两个副本；`.ps1` 不能直接 CreateProcess，不参与匹配。
#[cfg(windows)]
const EXTS: &[&str] = &[".com", ".exe", ".bat", ".cmd"];
#[cfg(not(windows))]
const EXTS: &[&str] = &[""];

fn looks_executable(p: &Path) -> bool {
    p.is_file()
}

/// 把 PATH 里的原始条目整理成可用路径：去引号、去空项、展开 `%VAR%`。
fn clean_path_entry(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(expand_env(trimmed))
}

fn path_sep() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

/// 展开 Windows 风格的 `%USERPROFILE%`（非 Windows 直接返回原值）
fn expand_env(input: &str) -> String {
    #[cfg(windows)]
    {
        let mut out = String::with_capacity(input.len());
        let mut rest = input;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            match after.find('%') {
                Some(end) => {
                    let name = &after[..end];
                    if let Ok(value) = std::env::var(name) {
                        out.push_str(&value);
                    } else {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                    rest = &after[end + 1..];
                }
                None => {
                    out.push_str(&rest[start..]);
                    return out;
                }
            }
        }
        out.push_str(rest);
        out
    }
    #[cfg(not(windows))]
    {
        input.to_string()
    }
}

fn dirs_from(path_env: &str) -> Vec<PathBuf> {
    path_env
        .split(path_sep())
        .filter_map(clean_path_entry)
        .map(PathBuf::from)
        .collect()
}

fn find_in_dirs<I: IntoIterator<Item = PathBuf>>(dirs: I) -> Option<PathBuf> {
    for base in dirs {
        for ext in EXTS {
            let candidate = if ext.is_empty() {
                base.join("vp")
            } else {
                base.join(format!("vp{ext}"))
            };
            if looks_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 进程启动时继承的 PATH（可能已经过期）
fn process_path_dirs() -> Vec<PathBuf> {
    std::env::var("PATH")
        .map(|p| dirs_from(&p))
        .unwrap_or_default()
}

/// 按需读取注册表里的用户 PATH（Windows）。GUI 进程的环境变量不会随
/// `vp env setup` 的写入自动刷新，所以在进程 PATH 找不到时才读注册表兜底。
#[cfg(windows)]
fn user_path_dirs() -> Vec<PathBuf> {
    let out = match new_command(Path::new("reg"))
        .args(["query", "HKCU\\Environment", "/v", "Path"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = decode_console(&out.stdout);
    for line in text.lines() {
        for marker in ["REG_EXPAND_SZ", "REG_SZ"] {
            if let Some(idx) = line.find(marker) {
                let value = line[idx + marker.len()..].trim();
                if !value.is_empty() {
                    return dirs_from(value);
                }
            }
        }
    }
    Vec::new()
}

#[cfg(not(windows))]
fn user_path_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// 控制台程序的输出可能是 UTF-16（例如 `reg.exe`），这里做一次宽松解码。
fn decode_console(bytes: &[u8]) -> String {
    let nul_ratio = if bytes.is_empty() {
        0.0
    } else {
        bytes.iter().filter(|b| **b == 0).count() as f64 / bytes.len() as f64
    };
    if bytes.len() >= 2 && nul_ratio > 0.25 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// 是否是项目内 `node_modules/.bin` 下的本地 vp。
/// 本地 vp 不具备 `env` 子命令（会报 "only available in the global vp CLI"），
/// 因此定位全局 CLI 时必须排除它们。
fn is_local_package_binary(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    text.contains("\\node_modules\\")
}

/// 已知的默认安装位置
fn known_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        out.push(home.join(".vite-plus").join("bin").join("vp.exe"));
        out.push(home.join(".vite-plus").join("bin").join("vp.cmd"));
        out.push(home.join(".vite-plus").join("bin").join("vp"));
        out.push(home.join(".viteplus").join("bin").join("vp.exe"));
        out.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("vp.cmd"),
        );
        out.push(
            home.join("AppData")
                .join("Local")
                .join("vite-plus")
                .join("bin")
                .join("vp.exe"),
        );
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(
            PathBuf::from(local)
                .join("vite-plus")
                .join("bin")
                .join("vp.exe"),
        );
    }
    if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
        out.push(PathBuf::from(&pnpm_home).join("vp.cmd"));
        out.push(PathBuf::from(&pnpm_home).join("vp.exe"));
    }
    out
}

fn normalize_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    // Windows 的 `\\?\`（以及 `\\?\UNC\`）只是 verbatim 前缀，比较时应忽略
    let text = raw
        .strip_prefix("\\\\?\\UNC\\")
        .map(|rest| format!("\\\\{rest}"))
        .or_else(|| raw.strip_prefix("\\\\?\\").map(str::to_string))
        .unwrap_or(raw);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// 所有可能存在的 vp 副本（去重后）。用于发现“不同终端用不同 vp”的影子冲突。
pub fn candidates() -> Vec<PathBuf> {
    let mut all: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("VP_PATH") {
        if let Some(entry) = clean_path_entry(&p) {
            all.push(PathBuf::from(entry));
        }
    }
    all.extend(process_path_dirs());
    all.extend(user_path_dirs());
    all.extend(known_locations());

    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in all {
        // known_locations() 返回的是完整可执行文件路径，直接判断即可
        if looks_executable(&entry) {
            let key = normalize_path_key(&entry);
            if seen.insert(key) {
                out.push(entry);
            }
            continue;
        }
        for ext in EXTS {
            let candidate = if ext.is_empty() {
                entry.join("vp")
            } else {
                entry.join(format!("vp{ext}"))
            };
            if looks_executable(&candidate) {
                let key = normalize_path_key(&candidate);
                if seen.insert(key) {
                    out.push(candidate);
                }
            }
        }
    }
    out
}

/// 定位 `vp` 可执行文件。优先级：用户配置 > 环境变量 VP_PATH > 全局 PATH（含注册表）
/// > 已知安装位置 > 项目内 node_modules/.bin（仅作最后兜底）。
/// 之所以把本地 vp 排到最后：它不提供 `env` 子命令，误用它会让整个环境管理不可用。
pub fn resolve(custom: Option<&str>) -> Result<PathBuf, String> {
    if let Some(c) = custom {
        let c = c.trim();
        if !c.is_empty() {
            let p = PathBuf::from(c);
            if looks_executable(&p) {
                return Ok(p);
            }
            return Err(format!("配置的 vp 路径不存在或不是文件：{c}"));
        }
    }
    if let Ok(p) = std::env::var("VP_PATH") {
        if let Some(entry) = clean_path_entry(&p) {
            let pb = PathBuf::from(entry);
            if looks_executable(&pb) {
                return Ok(pb);
            }
        }
    }

    let mut dirs = process_path_dirs();
    dirs.extend(user_path_dirs());
    let (global_dirs, local_dirs): (Vec<PathBuf>, Vec<PathBuf>) =
        dirs.into_iter().partition(|d| !is_local_package_binary(d));
    if let Some(p) = find_in_dirs(global_dirs) {
        return Ok(p);
    }
    for p in known_locations() {
        if looks_executable(&p) {
            return Ok(p);
        }
    }
    if let Some(p) = find_in_dirs(local_dirs) {
        return Ok(p);
    }
    Err(
        "未找到 Vite+ (vp) 可执行文件。请先安装 Vite+，或在设置中手动指定 vp.exe 路径。"
            .to_string(),
    )
}

// ------------------------------------------------------- vp 副本分类 / 冲突判定

/// 项目里声明 `vp` 的包名（实测为 `vite-plus`，其余为兼容写法）
const VP_PACKAGES: &[&str] = &[
    "vite-plus",
    "viteplus",
    "@vite-plus/cli",
    "@voidzero-dev/vite-plus",
];
/// 项目 `bin` 字段里可能暴露的 vp 可执行名
const VP_BINS: &[&str] = &["vp", "vpx", "vpr"];

/// 一个 vp 副本的归属：全局安装、项目依赖、或无法确认
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VpCandidate {
    pub path: String,
    pub version: Option<String>,
    /// global / project / unknown
    pub scope: String,
    /// scope=global 时的安装根目录
    pub global_root: Option<String>,
    /// scope=project 时的所属项目根目录
    pub project: Option<String>,
    pub primary: bool,
}

/// 会被当作「全局安装」的目录：只有这些位置才可能让不同终端解析到不同版本
fn global_install_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        out.push(home.join(".vite-plus"));
        out.push(home.join(".viteplus"));
        out.push(home.join(".bun").join("bin"));
        out.push(home.join(".yarn").join("bin"));
        out.push(home.join(".npm-global").join("bin"));
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        out.push(PathBuf::from(appdata).join("npm"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        out.push(local.join("pnpm"));
        out.push(local.join("Yarn").join("bin"));
        out.push(local.join("vite-plus"));
    }
    if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
        out.push(PathBuf::from(pnpm_home));
    }
    #[cfg(not(windows))]
    {
        for p in [
            "/usr/local/bin",
            "/usr/bin",
            "/opt/homebrew/bin",
            "/opt/local/bin",
        ] {
            out.push(PathBuf::from(p));
        }
        if let Ok(home) = std::env::var("HOME") {
            out.push(PathBuf::from(home).join(".local").join("bin"));
        }
    }
    out
}

fn effective_path_dirs() -> Vec<PathBuf> {
    let mut dirs = process_path_dirs();
    dirs.extend(user_path_dirs());
    dirs
}

/// 是否位于项目本地依赖布局（node_modules/.bin、.pnpm、.yarn 等）
fn is_local_layout(path: &Path) -> bool {
    let text = format!("\\{}", normalize_path_key(path));
    text.contains("\\node_modules\\") || text.contains("\\.pnpm\\") || text.contains("\\.yarn\\")
}

fn read_manifest(path: &Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn is_vp_package_manifest(value: &serde_json::Value) -> bool {
    value
        .get("name")
        .and_then(|v| v.as_str())
        .is_some_and(|name| VP_PACKAGES.iter().any(|p| name.eq_ignore_ascii_case(p)))
}

/// package.json 是否声明了 Vite+ CLI：依赖、packageManager 或 bin
fn declares_vp(manifest: &serde_json::Value) -> bool {
    for section in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if let Some(map) = manifest.get(section).and_then(|v| v.as_object()) {
            if map
                .keys()
                .any(|k| VP_PACKAGES.iter().any(|p| k.eq_ignore_ascii_case(p)))
            {
                return true;
            }
        }
    }
    if let Some(pm) = manifest.get("packageManager").and_then(|v| v.as_str()) {
        let lower = pm.to_lowercase();
        if VP_PACKAGES
            .iter()
            .any(|p| lower.contains(&p.to_lowercase()))
        {
            return true;
        }
    }
    match manifest.get("bin") {
        Some(serde_json::Value::Object(map)) => map
            .keys()
            .any(|k| VP_BINS.iter().any(|b| k.eq_ignore_ascii_case(b))),
        Some(serde_json::Value::String(s)) => VP_BINS
            .iter()
            .any(|b| s.to_lowercase().contains(&format!("bin/{b}"))),
        _ => false,
    }
}

/// 向上找到声明了该 CLI 的项目根；node_modules 布局取最外层 node_modules 的父目录
fn project_root_for(path: &Path) -> Option<PathBuf> {
    let mut outer: Option<PathBuf> = None;
    for ancestor in path.ancestors().skip(1) {
        if ancestor
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("node_modules"))
        {
            if let Some(parent) = ancestor.parent() {
                outer = Some(parent.to_path_buf());
            }
        }
    }
    if let Some(root) = outer {
        return Some(root);
    }
    // .yarn 等不带 node_modules 的布局：就近找一个声明了 vp 的 package.json
    for ancestor in path.ancestors().skip(1) {
        let manifest = ancestor.join("package.json");
        if !manifest.is_file() {
            continue;
        }
        if let Ok(value) = read_manifest(&manifest) {
            if is_vp_package_manifest(&value) {
                continue;
            }
            if declares_vp(&value) {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}

fn global_root_for(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let key = normalize_path_key(path);
    roots
        .iter()
        .find(|root| {
            let root_key = normalize_path_key(root);
            key == root_key || key.starts_with(&format!("{root_key}\\"))
        })
        .cloned()
}

fn dir_index(dir: &Path, dirs: &[PathBuf]) -> Option<usize> {
    let key = normalize_path_key(dir);
    dirs.iter().position(|d| normalize_path_key(d) == key)
}

/// 判断归属：项目本地依赖 → project；已知全局根 / PATH 中的系统级安装 → global；
/// 其余无法确认的一律 unknown（只进诊断，不打扰用户）
fn scope_of(
    path: &Path,
    global_roots: &[PathBuf],
    path_dirs: &[PathBuf],
) -> (String, Option<String>, Option<String>) {
    if is_local_layout(path) {
        if let Some(root) = project_root_for(path) {
            let manifest = root.join("package.json");
            if read_manifest(&manifest)
                .map(|v| declares_vp(&v))
                .unwrap_or(false)
            {
                return (
                    "project".to_string(),
                    None,
                    Some(root.to_string_lossy().to_string()),
                );
            }
        }
        return ("unknown".to_string(), None, None);
    }
    if let Some(root) = global_root_for(path, global_roots) {
        return (
            "global".to_string(),
            Some(root.to_string_lossy().to_string()),
            None,
        );
    }
    if let Some(dir) = path.parent() {
        if dir_index(dir, path_dirs).is_some() {
            return (
                "global".to_string(),
                Some(dir.to_string_lossy().to_string()),
                None,
            );
        }
    }
    ("unknown".to_string(), None, None)
}

/// 用于比较的规范键：优先 canonicalize（可解开符号链接与 `..`），失败时退回词法归一
fn canonical_path_key(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize_path_key(&resolved)
}

/// 去掉重复副本：同一真实路径、同一安装目录的 shim/真实 bin 成对出现时只保留第一个
fn dedupe_candidates(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let mut seen_dirs = std::collections::HashSet::new();
    for path in paths {
        let key = canonical_path_key(&path);
        if !seen_paths.insert(key) {
            continue;
        }
        let dir_key = canonical_path_key(path.parent().unwrap_or(&path));
        if seen_dirs.insert(dir_key) {
            out.push(path);
        }
    }
    out
}

fn classify_with(
    primary: &Path,
    known_version: Option<&str>,
    paths: Vec<PathBuf>,
    roots: &[PathBuf],
    dirs: &[PathBuf],
) -> Vec<VpCandidate> {
    let mut all = paths;
    if !all
        .iter()
        .any(|p| canonical_path_key(p) == canonical_path_key(primary))
    {
        all.insert(0, primary.to_path_buf());
    }
    let all = dedupe_candidates(all);
    let primary_key = canonical_path_key(primary);
    all.into_iter()
        .take(8)
        .map(|path| {
            let is_primary = canonical_path_key(&path) == primary_key;
            let version = if is_primary {
                known_version
                    .map(clean_version)
                    .or_else(|| version(&path).ok().map(|v| clean_version(&v)))
            } else {
                version(&path).ok().map(|v| clean_version(&v))
            };
            let (scope, global_root, project) = scope_of(&path, roots, dirs);
            VpCandidate {
                path: path.to_string_lossy().to_string(),
                version,
                scope,
                global_root,
                project,
                primary: is_primary,
            }
        })
        .collect()
}

// ---------------------------------------------------------- PATH / shim 审计

/// 单个工具在 PATH 中的实际命中情况
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ToolPathAudit {
    pub tool: String,
    /// vp 应该生成的 shim 路径（不存在时按平台惯例给出预期位置）
    pub shim_path: String,
    pub shim_exists: bool,
    /// PATH 中所有命中该工具的路径，按优先级从高到低；空表示完全没有命中
    pub hits: Vec<String>,
    /// 当前实际生效的路径是否由 Vite+ 管理（shim 或 vp 自己的 js_runtime）
    pub managed: bool,
    /// PATH 中不属于 Vite+ 的命中，可能来自系统安装
    pub foreign_hits: Vec<String>,
}

/// PATH / shim 是否真的生效：shim 是否生成、PATH 里首个命中是不是 shim、是否有多副本
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PathAudit {
    pub shim_dir: String,
    pub tools: Vec<ToolPathAudit>,
    pub warnings: Vec<String>,
    /// 所有 vp 副本及其归属，供环境 / 诊断页以普通信息行展示
    pub vp_candidates: Vec<VpCandidate>,
}

/// 审计的工具清单（npx / pnpx / bunx 也一起列出，避免用户以为只托管了主命令）
const AUDIT_TOOLS: &[&str] = &["node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx"];
/// 只有这些工具的异常会产生全局警告，避免 x 系列命令刷屏
const AUDIT_WARN_TOOLS: &[&str] = &["node", "npm", "pnpm", "yarn", "bun"];

fn tool_candidates(dir: &Path, tool: &str) -> Vec<PathBuf> {
    EXTS.iter()
        .map(|ext| {
            if ext.is_empty() {
                dir.join(tool)
            } else {
                dir.join(format!("{tool}{ext}"))
            }
        })
        .collect()
}

/// 按 PATH 顺序查找所有同名可执行文件（去重、保留第一个的优先级）
fn find_tool_all(tool: &str, dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in dirs {
        for candidate in tool_candidates(base, tool) {
            if looks_executable(&candidate) {
                let key = normalize_path_key(&candidate);
                if seen.insert(key) {
                    out.push(candidate);
                }
            }
        }
    }
    out
}

/// 把命中路径归并成「安装目录」：同一目录下的 npm / npm.cmd / npm.bat
/// 是同一个安装的不同入口，不是多个副本。
fn distinct_install_dirs(hits: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for hit in hits {
        let dir = Path::new(hit)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let key = normalize_path_key(Path::new(&dir));
        if seen.insert(key) {
            out.push(dir);
        }
    }
    out
}

/// 纯函数版本：给定 shim 目录与 PATH 目录，产出审计结果（便于单测）
pub fn audit_with_path(shim_dir: &Path, dirs: &[PathBuf]) -> PathAudit {
    let mut tools = Vec::new();
    let mut warnings = Vec::new();
    // shim 目录通常是 `<vp_home>/bin`；同级的 js_runtime 也属于 Vite+ 管理，
    // 不能因为首命中是 js_runtime 就误报“系统优先”。
    let vp_root = shim_dir.parent().unwrap_or(shim_dir);
    let vp_root_key = normalize_path_key(vp_root);
    let is_vp_owned = |hit: &str| {
        let key = normalize_path_key(Path::new(hit));
        key == vp_root_key || key.starts_with(&format!("{vp_root_key}\\"))
    };

    for tool in AUDIT_TOOLS {
        let existing = tool_candidates(shim_dir, tool)
            .into_iter()
            .find(|p| looks_executable(p));
        let shim_path = existing.unwrap_or_else(|| {
            if cfg!(windows) {
                shim_dir.join(format!("{tool}.exe"))
            } else {
                shim_dir.join(tool)
            }
        });
        let shim_exists = looks_executable(&shim_path);
        let hits: Vec<String> = find_tool_all(tool, dirs)
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        let shim_key = normalize_path_key(&shim_path);
        let shim_pos = hits
            .iter()
            .position(|h| normalize_path_key(Path::new(h)) == shim_key);
        let cutoff = shim_pos.unwrap_or(hits.len());
        let foreign_before: Vec<String> = hits
            .iter()
            .take(cutoff)
            .filter(|h| !is_vp_owned(h))
            .cloned()
            .collect();
        let foreign_hits: Vec<String> = hits.iter().filter(|h| !is_vp_owned(h)).cloned().collect();
        let managed = !hits.is_empty() && foreign_before.is_empty();

        if AUDIT_WARN_TOOLS.contains(tool) {
            if !shim_exists {
                warnings.push(format!(
                    "shim 缺失：{} 不存在，执行 `vp env setup --refresh` 重新生成。",
                    shim_path.display()
                ));
            } else if hits.is_empty() {
                warnings.push(format!(
                    "PATH 未命中 {tool}：shim 已生成，但当前进程 PATH 里没有 {}。",
                    shim_dir.display()
                ));
            }
            if let Some(first) = foreign_before.first() {
                warnings.push(format!(
                    "PATH 中 {tool} 在 Vite+ 之前命中了 {first}；系统安装可能优先生效。"
                ));
            }
            // 只有「排在 shim 之前、且来自不同安装目录」的副本才会让终端解析到不同版本；
            // 同目录下 npm / npm.cmd 这类多入口，以及 shim 之后的副本都不算。
            let foreign_before_dirs = distinct_install_dirs(&foreign_before);
            if foreign_before_dirs.len() > 1 {
                warnings.push(format!(
                    "PATH 中 {tool} 在 Vite+ 之前有 {} 个非 Vite+ 安装目录，不同终端可能解析到不同版本：{}",
                    foreign_before_dirs.len(),
                    foreign_before_dirs.join("；")
                ));
            }
        }

        tools.push(ToolPathAudit {
            tool: tool.to_string(),
            shim_path: shim_path.to_string_lossy().to_string(),
            shim_exists,
            hits,
            managed,
            foreign_hits,
        });
    }
    PathAudit {
        shim_dir: shim_dir.to_string_lossy().to_string(),
        tools,
        warnings,
        vp_candidates: Vec::new(),
    }
}

/// 审计当前进程 PATH（含注册表兜底）与 vp 所在目录的 shim
pub fn audit_path(vp: &Path) -> PathAudit {
    let shim_dir = vp.parent().map(Path::to_path_buf).unwrap_or_default();
    let dirs = effective_path_dirs();
    let mut audit = audit_with_path(&shim_dir, &dirs);
    audit.vp_candidates = classify_with(vp, None, candidates(), &global_install_roots(), &dirs);
    audit
}

/// 当前正在运行的 vp 子进程 pid（环境操作已被 ENV_OP_LOCK 串行化，最多一个）
static RUNNING_PID: Mutex<Option<u32>> = Mutex::new(None);
/// 用户点击取消后置位，运行循环会终止进程树并如实返回。
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

fn set_running(pid: Option<u32>) {
    if let Ok(mut guard) = RUNNING_PID.lock() {
        *guard = pid;
    }
}

/// 进程是否仍然存在（取消后用于确认是否真的退出）
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let out = new_command(Path::new("tasklist"))
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match out {
        Ok(o) => decode_console(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    new_command(Path::new("kill"))
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
pub struct CancelResult {
    pub cancelled: bool,
    pub pid: Option<u32>,
    pub exited: bool,
    pub message: String,
}

/// 取消当前正在运行的 vp 命令：置位取消标志并终止进程树，随后确认退出。
pub fn cancel_current() -> CancelResult {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    let pid = RUNNING_PID.lock().ok().and_then(|g| *g);
    let Some(pid) = pid else {
        return CancelResult {
            cancelled: false,
            pid: None,
            exited: true,
            message: "当前没有正在运行的 vp 命令。".to_string(),
        };
    };
    let killed = kill_tree(pid);
    let mut exited = !process_alive(pid);
    for _ in 0..15 {
        if exited {
            break;
        }
        thread::sleep(Duration::from_millis(200));
        exited = !process_alive(pid);
    }
    CancelResult {
        cancelled: killed,
        pid: Some(pid),
        exited,
        message: if exited {
            format!("已终止进程树（PID {pid}），确认已退出。")
        } else {
            format!(
                "已请求终止（PID {pid}），但进程仍在运行；请稍后用任务管理器确认，避免重复执行。"
            )
        },
    }
}

/// 从 vp 输出的一行推断当前处于哪个安装阶段（仅用于进度展示）
fn infer_phase(line: &str) -> Option<&'static str> {
    let s = line.to_lowercase();
    if s.contains("verify")
        || s.contains("checksum")
        || s.contains("signature")
        || s.contains("校验")
    {
        return Some("verify");
    }
    if s.contains("extract") || s.contains("unzip") || s.contains("解压") || s.contains("untar") {
        return Some("extract");
    }
    if s.contains("download") || s.contains("fetch") || s.contains("下载") {
        return Some("download");
    }
    if s.contains("resolv") || s.contains("registry") || s.contains("解析") {
        return Some("resolve");
    }
    Some("install")
}

/// 一条命令的原始输出。stdout 用于 JSON 解析，stderr 只做诊断，避免警告文本污染 JSON。
pub struct CmdOutput {
    pub stdout: String,
    pub stderr: String,
}

impl CmdOutput {
    fn combined(&self, label: &str) -> String {
        let mut buf = String::new();
        if !self.stdout.is_empty() {
            buf.push_str(&self.stdout);
        }
        if !self.stderr.is_empty() {
            if !buf.is_empty() {
                buf.push('\n');
            }
            buf.push_str(&self.stderr);
        }
        if buf.is_empty() {
            format!("{label} 执行完成（无输出）")
        } else {
            buf
        }
    }
}

/// 执行一条命令：边读边收集输出，支持取消与超时；`sink` 用于推送阶段进度。
fn run_core(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    label: &str,
    sink: Option<&dyn Fn(&str, &str)>,
) -> Result<CmdOutput, String> {
    let mut cmd = new_command(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        if !dir.as_os_str().is_empty() {
            cmd.current_dir(dir);
        }
    }
    cmd.env("VP_NO_COLOR", "1");
    cmd.env("NO_COLOR", "1");
    // GUI 下没有可交互的 stdin。vp 的破坏性命令没有 --yes/--force（pin 除外），
    // 因此确认由应用层负责；这里显式关闭 stdin，不依赖 EOF 被当成“确认”。
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("执行 {label} 失败: {e}"))?;
    let pid = child.id();
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    set_running(Some(pid));

    enum Msg {
        Line(bool, String),
    }
    let (tx, rx) = mpsc::channel::<Msg>();
    if let Some(stream) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(Msg::Line(false, line)).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(stream) = child.stderr.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(Msg::Line(true, line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut status = None;
    let mut cancelled = false;
    let mut timed_out = false;

    loop {
        while let Ok(Msg::Line(is_err, line)) = rx.try_recv() {
            if is_err {
                stderr.push_str(&line);
                stderr.push('\n');
            } else {
                stdout.push_str(&line);
                stdout.push('\n');
            }
            if let Some(sink) = sink {
                if let Some(phase) = infer_phase(&line) {
                    sink(phase, line.trim());
                }
            }
        }

        if CANCEL_FLAG.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                status = Some(s);
                break;
            }
            Ok(None) => {}
            Err(e) => {
                set_running(None);
                return Err(format!("等待 {label} 失败: {e}"));
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        thread::sleep(Duration::from_millis(80));
    }

    if cancelled || timed_out {
        let killed = kill_tree(pid);
        // 终止后等一小段时间，确认进程真的退出；否则提示用户可能仍有残留进程
        let mut exited = false;
        for _ in 0..50 {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        // 收尾：把已经产生的输出读干净
        thread::sleep(Duration::from_millis(100));
        while let Ok(Msg::Line(is_err, line)) = rx.try_recv() {
            if is_err {
                stderr.push_str(&line);
                stderr.push('\n');
            } else {
                stdout.push_str(&line);
                stdout.push('\n');
            }
        }
        set_running(None);
        let mut msg = if cancelled {
            format!("{label} 已被用户取消。")
        } else {
            format!("{label} 执行超过 {} 秒仍未结束，", timeout.as_secs())
        };
        if killed && exited {
            msg.push_str("已终止进程树，并确认进程退出。");
        } else {
            msg.push_str("终止进程失败或未确认退出，进程可能仍在后台运行；请先在任务管理器确认，避免重复执行。");
        }
        if !stdout.trim().is_empty() || !stderr.trim().is_empty() {
            msg.push_str("\n\n已产生的输出：\n");
            msg.push_str(stdout.trim());
            if !stderr.trim().is_empty() {
                msg.push('\n');
                msg.push_str(stderr.trim());
            }
        }
        msg.push_str(
            "\n\n若为安装 / 清理 / 卸载中断，可稍后用 `vp env list` 检查状态，必要时执行 `vp env clean`。",
        );
        return Err(msg);
    }

    // 读取线程可能还没把最后几行送过来
    for _ in 0..5 {
        while let Ok(Msg::Line(is_err, line)) = rx.try_recv() {
            if is_err {
                stderr.push_str(&line);
                stderr.push('\n');
            } else {
                stdout.push_str(&line);
                stdout.push('\n');
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    set_running(None);

    let stdout = stdout.trim().to_string();
    let stderr = stderr.trim().to_string();
    let out = CmdOutput {
        stdout: stdout.clone(),
        stderr: stderr.clone(),
    };
    match status {
        Some(s) if s.success() => Ok(out),
        Some(s) => Err(format!(
            "{label}，退出码 {:?}\n{}",
            s.code(),
            out.combined(label)
        )),
        None => Err(format!("{label} 未能确认退出状态")),
    }
}

fn run_raw(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    label: &str,
) -> Result<CmdOutput, String> {
    run_core(program, args, cwd, timeout, label, None)
}

/// 与 `run` 相同，但把输出行实时推给 `progress(phase, message)`。
pub fn run_with_progress(
    vp: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    progress: &dyn Fn(&str, &str),
) -> Result<String, String> {
    let label = format!("`vp {}`", args.join(" "));
    run_core(vp, args, cwd, timeout, &label, Some(progress)).map(|o| o.combined(&label))
}

fn run_impl(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    label: &str,
) -> Result<String, String> {
    run_raw(program, args, cwd, timeout, label).map(|o| o.combined(label))
}

/// 执行一条 `vp` 命令，返回合并后的 stdout+stderr 文本；超过 `timeout` 后终止子进程
pub fn run(
    vp: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<String, String> {
    let label = format!("`vp {}`", args.join(" "));
    run_impl(vp, args, cwd, timeout, &label)
}

/// 通过官方安装脚本安装最新版 Vite+
#[cfg(windows)]
pub fn install() -> Result<String, String> {
    // 显式把控制台输出编码切到 UTF-8，避免中文系统下安装日志变成乱码
    let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; irm https://vite.plus/ps1 | iex";
    let args: Vec<String> = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    run_impl(
        Path::new("powershell"),
        &args,
        None,
        TIMEOUT_BOOTSTRAP,
        "安装 Vite+",
    )
}

#[cfg(not(windows))]
pub fn install() -> Result<String, String> {
    let args: Vec<String> = ["-c", "curl -fsSL https://vite.plus | bash"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    run_impl(
        Path::new("sh"),
        &args,
        None,
        TIMEOUT_BOOTSTRAP,
        "安装 Vite+",
    )
}

/// `vp upgrade`：把全局 CLI 升到最新版本
pub fn upgrade(vp: &Path) -> Result<String, String> {
    run(vp, &["upgrade".to_string()], None, TIMEOUT_BOOTSTRAP)
}

/// 从输出里截取第一个完整的 JSON 对象 / 数组：
/// - 跳过 JSON 前面的提示行（如 `[warn] ...`）
/// - 允许 JSON 后面还有日志
/// - 正确跳过字符串里的括号与转义
fn extract_json(text: &str) -> Result<serde_json::Value, String> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            let start = offset + (line.len() - trimmed.len());
            if let Some(end) = scan_json_end(&text[start..]) {
                let slice = &text[start..start + end];
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(slice) {
                    return Ok(value);
                }
            }
        }
        offset += line.len();
    }
    Err(format!("命令未返回可解析的 JSON 数据：\n{text}"))
}

/// 返回从字符串开头到配对括号结束的字节长度（包含尾部括号）
fn scan_json_end(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let first = *bytes.first()?;
    if first != b'{' && first != b'[' {
        return None;
    }
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, b) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *b == b'\\' {
                escaped = true;
            } else if *b == b'"' {
                in_string = false;
            }
            continue;
        }
        match *b {
            b'"' => in_string = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// 执行一条 `vp --json` 命令并解析为 JSON
pub fn run_json(
    vp: &Path,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let label = format!("`vp {}`", args.join(" "));
    let out = run_raw(vp, args, cwd, timeout, &label)?;
    let primary = if out.stdout.trim().is_empty() {
        out.stderr.as_str()
    } else {
        out.stdout.as_str()
    };
    extract_json(primary).map_err(|e| format!("{e}\n{}", out.combined(&label)))
}

/// `vp --version`
pub fn version(vp: &Path) -> Result<String, String> {
    run(vp, &["--version".to_string()], None, TIMEOUT_DEFAULT)
}

// ---------------------------------------------------------------- 参数拼装
// 这些构建函数是纯函数，便于单测；命令层只负责解析 vp 与加锁。

fn push_nonempty(args: &mut Vec<String>, value: Option<&str>) {
    if let Some(v) = value.map(str::trim).filter(|s| !s.is_empty()) {
        args.push(v.to_string());
    }
}

pub fn env_install_args(spec: Option<&str>) -> Vec<String> {
    let mut args = vec!["env".to_string(), "install".to_string()];
    push_nonempty(&mut args, spec);
    args
}

pub fn env_list_remote_args(selector: Option<&str>, lts: bool, all: bool) -> Vec<String> {
    let mut args = vec!["env".to_string(), "list-remote".to_string()];
    push_nonempty(&mut args, selector);
    if lts {
        args.push("--lts".to_string());
    }
    if all {
        args.push("--all".to_string());
    }
    args.push("--json".to_string());
    args
}

pub fn env_pin_args(
    specs: &[String],
    target: Option<&str>,
    force: bool,
    no_install: bool,
) -> Vec<String> {
    let mut args = vec!["env".to_string(), "pin".to_string()];
    args.extend(specs.iter().filter(|s| !s.trim().is_empty()).cloned());
    if let Some(t) = target.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--target".to_string());
        args.push(t.to_string());
    }
    if force {
        args.push("--force".to_string());
    }
    if no_install {
        args.push("--no-install".to_string());
    }
    args
}

pub fn env_unpin_args(scope: Option<&str>, target: Option<&str>) -> Vec<String> {
    let mut args = vec!["env".to_string(), "unpin".to_string()];
    push_nonempty(&mut args, scope);
    if let Some(t) = target.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--target".to_string());
        args.push(t.to_string());
    }
    args
}

pub fn env_default_args(spec: Option<&str>, unset: bool) -> Vec<String> {
    let mut args = vec!["env".to_string(), "default".to_string()];
    push_nonempty(&mut args, spec);
    if unset {
        args.push("--unset".to_string());
    }
    args
}

pub fn env_clean_args(selector: Option<&str>) -> Vec<String> {
    let mut args = vec!["env".to_string(), "clean".to_string()];
    push_nonempty(&mut args, selector);
    args
}

pub fn env_mode_args(managed: bool, selector: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "env".to_string(),
        if managed { "on" } else { "off" }.to_string(),
    ];
    push_nonempty(&mut args, selector);
    args
}

pub fn env_setup_args(refresh: bool, env_only: bool) -> Vec<String> {
    let mut args = vec!["env".to_string(), "setup".to_string()];
    if refresh {
        args.push("--refresh".to_string());
    }
    if env_only {
        args.push("--env-only".to_string());
    }
    args
}

pub fn env_use_args(
    specs: &[String],
    unset: bool,
    no_install: bool,
    silent_if_unchanged: bool,
) -> Vec<String> {
    let mut args = vec!["env".to_string(), "use".to_string()];
    if unset {
        args.push("--unset".to_string());
    }
    if no_install {
        args.push("--no-install".to_string());
    }
    if silent_if_unchanged {
        args.push("--silent-if-unchanged".to_string());
    }
    args.extend(specs.iter().filter(|s| !s.trim().is_empty()).cloned());
    args
}

/// 校验这个可执行文件确实是 vp：优先看版本输出里的名字，输出过于简略时再探测 `env --help`。
pub fn verify_identity(vp: &Path, version_text: &str) -> Result<(), String> {
    if version_identity(version_text) {
        return Ok(());
    }
    let help = run(
        vp,
        &["env".to_string(), "--help".to_string()],
        None,
        TIMEOUT_DEFAULT,
    );
    if let Ok(text) = help {
        let lower = text.to_lowercase();
        if lower.contains("env") && text.contains("Usage") {
            return Ok(());
        }
    }
    Err(format!(
        "所选程序不是 Vite+ (vp)：{}（`--version` 输出为 {:?}）",
        vp.display(),
        clean_version(version_text)
    ))
}

/// 只有三种情况才打扰用户：
/// 1. ≥2 个不同的全局安装且版本不同；
/// 2. PATH 里另一个全局安装排在当前托管 shim 之前（系统优先，覆盖生效版本）；
/// 3. 同一全局安装目录里残留多个版本。
/// 项目本地依赖（版本与全局不同也正常）与无法确认归属的副本不告警。
fn vp_copy_warnings(primary: &Path) -> Vec<String> {
    let dirs = effective_path_dirs();
    let roots = global_install_roots();
    let list = classify_with(primary, None, candidates(), &roots, &dirs);
    copy_warnings_for(primary, &list, &dirs)
}

/// 纯函数版本：给定已分类的副本与 PATH 顺序，产出告警（便于单测）
fn copy_warnings_for(primary: &Path, list: &[VpCandidate], dirs: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    let primary_key = canonical_path_key(primary);
    let primary_candidate = list
        .iter()
        .find(|c| canonical_path_key(Path::new(&c.path)) == primary_key);
    let globals: Vec<&VpCandidate> = list.iter().filter(|c| c.scope == "global").collect();
    if globals.is_empty() {
        return out;
    }

    // 按安装根归组
    let mut by_root: Vec<(String, Vec<&VpCandidate>)> = Vec::new();
    for g in &globals {
        let root = g.global_root.clone().unwrap_or_else(|| g.path.clone());
        if let Some((_, items)) = by_root.iter_mut().find(|(r, _)| r == &root) {
            items.push(g);
        } else {
            by_root.push((root, vec![g]));
        }
    }

    // 1) 不同全局安装且版本不同
    let mut known_versions = std::collections::HashSet::new();
    for (_, items) in &by_root {
        if let Some(v) = items.first().and_then(|i| i.version.clone()) {
            known_versions.insert(v);
        }
    }
    if by_root.len() >= 2 && known_versions.len() >= 2 {
        out.push(
            "全局安装冲突：检测到多个全局 Vite+ 安装且版本不一致，不同终端可能用到不同版本。"
                .to_string(),
        );
        for (root, items) in &by_root {
            let first = items[0];
            out.push(format!(
                "  {} → {}（安装根：{root}）",
                first.path,
                first
                    .version
                    .clone()
                    .unwrap_or_else(|| "无法读取版本".into())
            ));
        }
        out.push(
            "建议：只保留一个全局安装（vp upgrade 或卸载多余副本），新开终端后重新检测。"
                .to_string(),
        );
    }

    // 2) PATH 顺序被另一个全局安装覆盖（仅当前主副本本身是全局安装时判断）
    if let Some(pc) = primary_candidate {
        if pc.scope == "global" {
            let shim_dir = primary.parent().unwrap_or(primary);
            let primary_pos = dir_index(shim_dir, &dirs);
            if let Some(other) = globals.iter().find(|g| {
                canonical_path_key(Path::new(&g.path)) != primary_key
                    && !(pc.global_root.is_some() && g.global_root == pc.global_root)
                    && match (
                        Path::new(&g.path)
                            .parent()
                            .and_then(|d| dir_index(d, &dirs)),
                        primary_pos,
                    ) {
                        (Some(gp), Some(pp)) => gp < pp,
                        (Some(_), None) => true,
                        _ => false,
                    }
            }) {
                out.push(format!(
                    "PATH 顺序被覆盖：{}（{}）排在 Vite+ 托管目录 {} 之前，终端会优先解析到它。",
                    other.path,
                    other
                        .version
                        .clone()
                        .unwrap_or_else(|| "无法读取版本".into()),
                    shim_dir.display()
                ));
                out.push(
                    "建议：把 Vite+ 托管的 shim 目录移到 PATH 前面，新开终端后重新检测。"
                        .to_string(),
                );
            }
        }
    }

    // 3) 同一全局安装目录残留多个版本
    for (root, items) in &by_root {
        let mut versions = std::collections::HashSet::new();
        for item in items {
            if let Some(v) = &item.version {
                versions.insert(v.clone());
            }
        }
        if versions.len() >= 2 {
            let detail = items
                .iter()
                .map(|i| {
                    format!(
                        "{} → {}",
                        i.path,
                        i.version.clone().unwrap_or_else(|| "无法读取版本".into())
                    )
                })
                .collect::<Vec<_>>()
                .join("；");
            out.push(format!(
                "同一全局安装目录 {root} 存在多个版本残留：{detail}。"
            ));
            out.push("建议：执行 vp env clean 或删除多余版本残留后重新检测。".to_string());
        }
    }

    out
}

fn ensure_failed(mut result: EnsureResult, mut logs: Vec<String>, message: String) -> EnsureResult {
    logs.push(message.clone());
    result.ok = false;
    result.compliant = false;
    result.error = Some(message);
    result.log = logs.join("\n\n");
    result
}

/// 启动自检：确保 vp 存在且版本 >= 1.5.0。
/// `allow_mutation = false` 时只检测，不安装 / 不升级（启动路径用它）；
/// 用户明确点击「自动安装 / 升级」时才传 true。
/// `progress(phase, message)` 用于向前端推送当前步骤。
pub fn ensure<F>(custom: Option<&str>, allow_mutation: bool, progress: F) -> EnsureResult
where
    F: Fn(&str, &str),
{
    let mut result = EnsureResult::new();
    let mut logs: Vec<String> = Vec::new();

    let _guard = match try_lock_env() {
        Ok(g) => g,
        Err(e) => return ensure_failed(result, logs, e),
    };

    progress("check", "正在检查 Vite+ 环境…");
    let custom_path = custom.map(str::trim).filter(|s| !s.is_empty());

    let mut vp = match resolve(custom) {
        Ok(p) => Some(p),
        Err(e) => {
            // 用户手动配置了路径却不可用：不要悄悄再装一份，先让其修正配置
            if custom_path.is_some() {
                return ensure_failed(result, logs, format!("配置的 vp 路径不可用：{e}"));
            }
            if !allow_mutation {
                result.warnings = Vec::new();
                return ensure_failed(
                    result,
                    logs,
                    "未检测到 Vite+ (vp)。点击「自动安装 / 升级」可安装最新版，或在设置中手动指定 vp 路径。"
                        .to_string(),
                );
            }
            progress(
                "install",
                "未检测到 Vite+，正在安装最新版本（首次安装可能需要几分钟）…",
            );
            match install() {
                Ok(out) => {
                    logs.push(format!("安装 Vite+：\n{out}"));
                    result.installed = true;
                    result.actions.push("安装 Vite+ 最新版本".to_string());
                }
                Err(e) => {
                    return ensure_failed(result, logs, format!("自动安装 Vite+ 失败：{e}"));
                }
            }
            match resolve(None) {
                Ok(p) => Some(p),
                Err(e) => {
                    return ensure_failed(
                        result,
                        logs,
                        format!("安装脚本已结束，但仍未找到 vp：{e}"),
                    );
                }
            }
        }
    };

    let vp = match vp.take() {
        Some(p) => p,
        None => return ensure_failed(result, logs, "未能定位 vp 可执行文件".to_string()),
    };
    result.path = Some(vp.to_string_lossy().to_string());

    progress("version", "正在读取 Vite+ 版本…");
    let raw_version = match version(&vp) {
        Ok(v) => v,
        Err(e) => return ensure_failed(result, logs, format!("读取 Vite+ 版本失败：{e}")),
    };
    if let Err(e) = verify_identity(&vp, &raw_version) {
        return ensure_failed(result, logs, e);
    }
    let before = clean_version(&raw_version);
    result.version = Some(before.clone());
    result.warnings = vp_copy_warnings(&vp);

    let before_tuple = match parse_version(&before) {
        Some(v) => v,
        None => {
            return ensure_failed(
                result,
                logs,
                format!("无法解析 Vite+ 版本号：{raw_version}"),
            );
        }
    };

    if before_tuple >= MIN_VERSION_TUPLE {
        result.ok = true;
        result.compliant = true;
        result.log = logs.join("\n\n");
        progress(
            "done",
            &format!("Vite+ v{before} 已满足 ≥ {MIN_VERSION} 要求"),
        );
        return result;
    }

    if !allow_mutation {
        result.compliant = false;
        result.log = logs.join("\n\n");
        result.error = Some(format!(
            "检测到 Vite+ v{before}，低于 {MIN_VERSION}。点击「自动安装 / 升级」执行 vp upgrade。"
        ));
        return result;
    }

    result.previous_version = Some(before.clone());
    progress(
        "upgrade",
        &format!(
            "检测到 Vite+ v{before}，低于 {MIN_VERSION}，正在执行 vp upgrade（可能需要几分钟）…"
        ),
    );
    match upgrade(&vp) {
        Ok(out) => {
            logs.push(format!("vp upgrade：\n{out}"));
            result.upgraded = true;
            result
                .actions
                .push(format!("升级 Vite+ {before} → ≥ {MIN_VERSION}"));
        }
        Err(e) => {
            return ensure_failed(result, logs, format!("自动升级 Vite+ 失败：{e}"));
        }
    }

    let vp_after = resolve(custom).or_else(|_| resolve(None)).unwrap_or(vp);
    if !looks_executable(&vp_after) {
        return ensure_failed(
            result,
            logs,
            format!("升级后未找到 vp 可执行文件：{}", vp_after.display()),
        );
    }
    result.path = Some(vp_after.to_string_lossy().to_string());
    let raw_after = match version(&vp_after) {
        Ok(v) => v,
        Err(e) => {
            return ensure_failed(result, logs, format!("升级后读取 Vite+ 版本失败：{e}"));
        }
    };
    if let Err(e) = verify_identity(&vp_after, &raw_after) {
        return ensure_failed(result, logs, e);
    }
    let after = clean_version(&raw_after);
    result.version = Some(after.clone());
    result.warnings = vp_copy_warnings(&vp_after);

    if !is_supported(&after) {
        return ensure_failed(
            result,
            logs,
            format!(
                "升级后版本仍为 v{after}，低于 {MIN_VERSION}，请检查网络或手动执行 `vp upgrade`。"
            ),
        );
    }

    result.ok = true;
    result.compliant = true;
    result.log = logs.join("\n\n");
    progress("done", &format!("Vite+ 已升级至 v{after}"));
    result
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiagItem {
    /// ok / warn / error / info
    pub level: String,
    pub text: String,
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DoctorReport {
    pub raw: String,
    pub items: Vec<DiagItem>,
    pub summary: String,
    pub errors: usize,
    pub warnings: usize,
    pub healthy: bool,
}

fn suggestion_for(text: &str) -> Option<&'static str> {
    let s = text.to_lowercase();
    if s.contains("path") || s.contains("环境变量") {
        return Some("执行 `vp env setup --refresh`，然后新开终端（或重启本应用）让 PATH 生效。");
    }
    if s.contains("shim") {
        return Some("执行 `vp env setup --refresh` 重新生成 shim，并确认其目录在 PATH 中。");
    }
    if s.contains("pin") || s.contains("固定") || s.contains(".nvmrc") || s.contains("node-version")
    {
        return Some("到「项目」页查看 pin 命中层级；冲突时先 unpin，再重新 pin 到当前目录。");
    }
    if s.contains("network")
        || s.contains("registry")
        || s.contains("download")
        || s.contains("网络")
        || s.contains("timeout")
    {
        return Some("检查网络 / 代理后重试；离线时可直接使用已缓存的版本列表。");
    }
    if s.contains("permission") || s.contains("denied") || s.contains("权限") {
        return Some(
            "确认安装目录可写（不要装在受保护的 Program Files 子目录），或以当前用户重试。",
        );
    }
    // Vite+ 1.5.0 新增的失败类目（见 1.5.0 发布说明的 doctor 条目）
    if s.contains("unreadable") || s.contains("配置") || s.contains("config") {
        return Some(
            "检查 Vite+ 配置目录（默认 ~/.vite-plus/config.json）是否存在且为合法 JSON；可先备份再重新生成。",
        );
    }
    if s.contains("system node") || s.contains("系统 node") {
        return Some("系统 Node 无法正常运行；检查 PATH 中的 node 是否损坏，或改用 managed 模式。");
    }
    if s.contains("resolution") || s.contains("resolve") || s.contains("解析") {
        return Some(
            "确认 `.node-version` / `.nvmrc` / `package.json` 中声明的 Node 版本格式合法且可获取，修正后重试。",
        );
    }
    if s.contains("version") || s.contains("版本") {
        return Some("版本过低时执行 `vp upgrade`；升级后重新打开终端。");
    }
    None
}

fn diag_level(line: &str) -> &'static str {
    let trimmed = line.trim_start_matches(['-', '*', ' ']);
    let lower = trimmed.to_lowercase();
    if ["✗", "✕", "✘", "×"].iter().any(|m| trimmed.starts_with(m))
        || ["error", "fail", "失败", "错误", "异常"]
            .iter()
            .any(|m| lower.starts_with(m) || lower.contains(&format!(" {m}")))
    {
        return "error";
    }
    if ["⚠", "△"].iter().any(|m| trimmed.starts_with(m))
        || ["warn", "警告", "注意"]
            .iter()
            .any(|m| lower.starts_with(m) || lower.contains(&format!(" {m}")))
    {
        return "warn";
    }
    if ["✓", "✔", "√", "ok", "pass"].iter().any(|m| {
        let l = lower.trim_start();
        l.starts_with(m) || l.contains(&format!(" {m}"))
    }) {
        return "ok";
    }
    "info"
}

/// 把 doctor 的自由文本整理成结构化条目；无法识别的行保留为 info。
pub fn parse_doctor(raw: &str) -> DoctorReport {
    let mut items = Vec::new();
    for line in raw.lines() {
        let text = line
            .trim()
            .trim_start_matches(['-', '*', '•'])
            .trim()
            .to_string();
        if text.is_empty() || text.chars().all(|c| matches!(c, '=' | '-' | '_' | ' ')) {
            continue;
        }
        let level = diag_level(&text);
        let suggestion = if level == "warn" || level == "error" {
            suggestion_for(&text).map(str::to_string)
        } else {
            None
        };
        items.push(DiagItem {
            level: level.to_string(),
            text: text
                .trim_start_matches(['✓', '✔', '√', '✗', '✕', '✘', '⚠', '△', '×'])
                .trim()
                .to_string(),
            suggestion,
        });
    }
    let errors = items.iter().filter(|i| i.level == "error").count();
    let warnings = items.iter().filter(|i| i.level == "warn").count();
    let summary = doctor_summary(&items, warnings, errors);
    DoctorReport {
        raw: raw.to_string(),
        items,
        summary,
        errors,
        warnings,
        healthy: errors == 0,
    }
}

fn doctor_summary(items: &[DiagItem], warnings: usize, errors: usize) -> String {
    let ok = items.iter().filter(|i| i.level == "ok").count();
    format!(
        "共 {} 项：{} 正常 · {} 警告 · {} 失败",
        items.len(),
        ok,
        warnings,
        errors
    )
}

/// 在 `parse_doctor` 基础上叠加命令退出状态。
///
/// Vite+ 1.5.0 起 `vp env doctor` 发现问题会以退出码 1 结束（PR #3215/#3222）。
/// 只看文本标记会把「非零退出但行内无 error 关键字」「命令超时」「进程无法启动」
/// 误判为健康，因此失败时强制记一次 error。
pub fn parse_doctor_with_status(raw: &str, succeeded: bool) -> DoctorReport {
    let mut report = parse_doctor(raw);
    if succeeded {
        return report;
    }
    report.healthy = false;
    if report.errors == 0 {
        report.errors = 1;
        report.items.insert(
            0,
            DiagItem {
                level: "error".into(),
                text: "vp env doctor 未成功结束：可能发现了问题，或命令执行失败（超时 / 无法启动）。"
                    .into(),
                suggestion: Some(
                    "先在本机执行 `vp env doctor` 查看具体失败项；若为超时或网络问题，检查网络 / 代理后重试。"
                        .into(),
                ),
            },
        );
    }
    report.summary = doctor_summary(&report.items, report.warnings, report.errors);
    report
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WhichReport {
    pub tool: String,
    pub raw: String,
    /// 解析出的路径（可能为空）
    pub path: String,
    pub exists: bool,
    /// `Version:` 行（Node / 包管理器的版本）
    pub version: Option<String>,
    /// `Package:` 行（如 `bun@1.4.4`）
    pub package: Option<String>,
    /// `Source:` 行（解析来源，例如 config.json）
    pub source: Option<String>,
    pub suggestion: Option<String>,
}

/// 取 `Key: value` 行里 value；key 大小写不敏感
fn after_key(line: &str, key: &str) -> Option<String> {
    let (name, rest) = line.trim().split_once(':')?;
    if name.trim().eq_ignore_ascii_case(key) {
        let value = rest.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// 这些行不是路径，避免把 `Version: 1.4.0` 当成可执行文件路径
fn is_meta_line(line: &str) -> bool {
    let (name, _) = match line.split_once(':') {
        Some(p) => p,
        None => return false,
    };
    ["version", "package", "source", "path", "mode", "installed"]
        .iter()
        .any(|k| name.trim().eq_ignore_ascii_case(k))
}

pub fn parse_which(tool: &str, raw: &str) -> WhichReport {
    let mut path = String::new();
    let mut version = None;
    let mut package = None;
    let mut source = None;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if version.is_none() {
            version = after_key(t, "Version");
        }
        if package.is_none() {
            package = after_key(t, "Package");
        }
        if source.is_none() {
            source = after_key(t, "Source");
        }
        if let Some(p) = after_key(t, "Path") {
            path = p.trim_matches('"').to_string();
            continue;
        }
        if is_meta_line(t) {
            continue;
        }
        let candidate = t.rsplit("->").next().unwrap_or(t).trim().trim_matches('"');
        if candidate.len() > 2
            && (candidate.as_bytes()[1] == b':'
                || candidate.starts_with('/')
                || candidate.starts_with("\\\\"))
        {
            path = candidate.to_string();
            continue;
        }
        if path.is_empty() && t.split_whitespace().count() <= 2 {
            path = candidate.to_string();
        }
    }
    let exists = !path.is_empty() && Path::new(&path).exists();
    let suggestion = if exists {
        None
    } else {
        Some(format!(
            "未找到 {tool}。请确认它已安装并在当前 PATH 中，执行 `vp env setup --refresh` 后新开终端。"
        ))
    };
    WhichReport {
        tool: tool.to_string(),
        raw: raw.to_string(),
        path,
        exists,
        version,
        package,
        source,
        suggestion,
    }
}

/// `vp upgrade --check` 的结构化结果
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpgradeCheck {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub up_to_date: bool,
    pub raw: String,
}

pub fn parse_upgrade_check(raw: &str) -> UpgradeCheck {
    let mut current: Option<String> = None;
    let mut latest: Option<String> = None;
    let lower_all = raw.to_lowercase();
    for line in raw.lines() {
        let t = line
            .trim()
            .trim_start_matches(['✓', '✔', '√', '-', '*', '•'])
            .trim();
        if t.is_empty() {
            continue;
        }
        if current.is_none() {
            current = after_key(t, "current").or_else(|| after_key(t, "当前"));
        }
        if latest.is_none() {
            for key in ["latest", "new", "available", "target", "最新"] {
                if let Some(v) = after_key(t, key) {
                    latest = Some(v);
                    break;
                }
            }
        }
        // `Already up to date (1.4.0)` / `已是最新版本 (1.4.0)`
        let says_uptodate = lower_all.contains("up to date")
            || lower_all.contains("up-to-date")
            || raw.contains("已是最新");
        if says_uptodate && latest.is_none() {
            if let (Some(start), Some(end)) = (t.find('('), t.rfind(')')) {
                if end > start + 1 {
                    let inner = &t[start + 1..end];
                    if parse_version(inner).is_some() {
                        latest = Some(inside_version(inner));
                    }
                }
            }
        }
    }
    let current = current.map(|v| clean_version(&v));
    let latest = latest.map(|v| clean_version(&v));
    let says_uptodate = lower_all.contains("up to date")
        || lower_all.contains("up-to-date")
        || raw.contains("已是最新");
    let up_to_date = match (&current, &latest) {
        (Some(c), Some(l)) => c == l,
        _ => says_uptodate,
    };
    UpgradeCheck {
        current,
        latest,
        up_to_date,
        raw: raw.to_string(),
    }
}

/// 去掉括号内可能出现的 `v` 前缀与说明文字
fn inside_version(text: &str) -> String {
    let cleaned = text
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    cleaned.trim_start_matches('v').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vp_version_output() {
        assert_eq!(clean_version("vp v1.4.0"), "1.4.0");
        assert_eq!(clean_version("vite-plus 1.1.0\n"), "1.1.0");
        assert_eq!(parse_version("vp v1.4.0"), Some((1, 4, 0)));
        assert_eq!(parse_version("1.4"), Some((1, 4, 0)));
        assert!(!is_supported("vp v1.3.9"));
        assert!(!is_supported("vp v1.4.0"));
        assert!(is_supported("vp v1.5.0"));
        assert!(is_supported("vp v2.0.0"));
    }

    #[test]
    fn identifies_vp_and_rejects_other_programs() {
        assert!(version_identity("vp v1.4.0"));
        assert!(version_identity("vite-plus 1.1.0"));
        assert!(version_identity(
            "vp v1.4.0\n\nLocal vite-plus:\n  vite-plus v1.4.0\n"
        ));
        assert!(!version_identity("v26.13.0"));
        assert!(!version_identity("git version 2.45.1"));
    }

    #[test]
    fn extracts_json_after_warnings() {
        let text = "[warn] registry slow\n[warn] retry\n{\"node\":[{\"version\":\"22.11.0\"}]}\n";
        let value = extract_json(text).unwrap();
        assert_eq!(value["node"][0]["version"], "22.11.0");
    }

    #[test]
    fn extracts_json_with_trailing_logs() {
        let text = "{\"a\":[1,2],\"s\":\"}\"}\nINFO done in 120ms\n";
        let value = extract_json(text).unwrap();
        assert_eq!(value["a"][1], 2);
        assert_eq!(value["s"], "}");
    }

    #[test]
    fn tolerates_pretty_printed_arrays_and_brackets_in_strings() {
        let text = "note\n[\n  {\"path\":\"C:\\\\dir[x]\\\\\"}\n]\nbye\n";
        let value = extract_json(text).unwrap();
        assert_eq!(value[0]["path"], "C:\\dir[x]\\");
    }

    #[test]
    fn rejects_text_without_json() {
        assert!(extract_json("vp env current\nno data here\n").is_err());
    }

    #[test]
    fn scan_stops_at_matching_bracket_only() {
        assert_eq!(scan_json_end("{} trailing"), Some(2));
        assert_eq!(scan_json_end("[1, 2] extra"), Some(6));
        assert_eq!(scan_json_end("{\"s\": \"[}\""), None);
    }

    #[test]
    fn cleans_quoted_and_empty_path_entries() {
        assert_eq!(
            clean_path_entry("\"C:\\tools\\bin\""),
            Some("C:\\tools\\bin".to_string())
        );
        assert_eq!(clean_path_entry("   "), None);
        assert_eq!(clean_path_entry("\"\""), None);
    }

    #[test]
    fn builds_env_command_arguments() {
        assert_eq!(env_install_args(None), vec!["env", "install"]);
        assert_eq!(
            env_install_args(Some(" node@22 ")),
            vec!["env", "install", "node@22"]
        );
        assert_eq!(
            env_list_remote_args(Some("node"), true, false),
            vec!["env", "list-remote", "node", "--lts", "--json"]
        );
        assert_eq!(
            env_list_remote_args(None, false, true),
            vec!["env", "list-remote", "--all", "--json"]
        );
        assert_eq!(
            env_pin_args(&["node@22".to_string()], Some("npmrc"), true, true),
            vec![
                "env",
                "pin",
                "node@22",
                "--target",
                "npmrc",
                "--force",
                "--no-install"
            ]
        );
        assert_eq!(
            env_unpin_args(None, Some("dev-engines")),
            vec!["env", "unpin", "--target", "dev-engines"]
        );
        assert_eq!(
            env_default_args(Some("node@20"), false),
            vec!["env", "default", "node@20"]
        );
        assert_eq!(
            env_default_args(None, true),
            vec!["env", "default", "--unset"]
        );
        assert_eq!(env_clean_args(Some("pnpm")), vec!["env", "clean", "pnpm"]);
        assert_eq!(env_mode_args(false, None), vec!["env", "off"]);
        assert_eq!(
            env_setup_args(true, true),
            vec!["env", "setup", "--refresh", "--env-only"]
        );
        assert_eq!(
            env_use_args(&["22".to_string()], false, true, false),
            vec!["env", "use", "--no-install", "22"]
        );
    }

    #[test]
    fn doctor_report_is_structured() {
        let raw = "Checking environment\n✓ vp 1.4.0\n✓ Node 22.11.0\n⚠ PATH 中存在多个 vp 副本\n✗ shim 目录缺失\n";
        let report = parse_doctor(raw);
        assert_eq!(report.errors, 1);
        assert_eq!(report.warnings, 1);
        assert!(!report.healthy);
        assert_eq!(report.items.iter().filter(|i| i.level == "ok").count(), 2);
        assert!(report
            .items
            .iter()
            .any(|i| i.level == "error" && i.suggestion.is_some()));
    }

    #[test]
    fn doctor_report_treats_failed_run_as_unhealthy() {
        // 1.5.0 起非零退出即为诊断未通过，即使输出行里没有任何 error 标记。
        let raw = "Installation\n  ✓ Shims\n";
        let report = parse_doctor_with_status(raw, false);
        assert!(!report.healthy);
        assert_eq!(report.errors, 1);
        assert!(report.items.iter().any(|i| i.level == "error"));
        assert_eq!(report.items.iter().filter(|i| i.level == "ok").count(), 1);
    }

    #[test]
    fn doctor_report_does_not_double_count_error_lines() {
        let raw = "`vp env doctor`，退出码 1\n✗ shim 目录缺失\n";
        let report = parse_doctor_with_status(raw, false);
        assert!(!report.healthy);
        assert_eq!(report.errors, 1);
    }

    #[test]
    fn which_report_extracts_path() {
        let raw = "node -> C:\\Users\\me\\.vite-plus\\bin\\node.exe\n";
        let report = parse_which("node", raw);
        assert!(report.path.ends_with("node.exe"));
        let missing = parse_which("node", "which: no node in PATH\n");
        assert!(!missing.exists);
        assert!(missing.suggestion.is_some());
    }

    #[test]
    fn which_report_parses_version_package_and_source() {
        let raw = "C:\\Users\\me\\.vite-plus\\bin\\node.exe\nVersion: v26.13.0\nSource: C:\\Users\\me\\.vite-plus\\config.json\n";
        let report = parse_which("node", raw);
        assert!(report.path.ends_with("node.exe"));
        assert_eq!(report.version.as_deref(), Some("v26.13.0"));
        assert_eq!(
            report.source.as_deref(),
            Some("C:\\Users\\me\\.vite-plus\\config.json")
        );

        let pm = "Package: bun@1.4.4\nSource: C:\\Users\\me\\.vite-plus\\config.json\n";
        let report = parse_which("bun", pm);
        assert_eq!(report.package.as_deref(), Some("bun@1.4.4"));
        assert_eq!(report.version, None);
    }

    #[test]
    fn parses_upgrade_check_output() {
        let raw = "Checking for updates\ncurrent: 1.4.0\n✓ Already up to date (1.4.0)\n";
        let check = parse_upgrade_check(raw);
        assert_eq!(check.current.as_deref(), Some("1.4.0"));
        assert_eq!(check.latest.as_deref(), Some("1.4.0"));
        assert!(check.up_to_date);

        let newer = "current: 1.4.0\nlatest: 1.5.0\nRun `vp upgrade` to update.\n";
        let check = parse_upgrade_check(newer);
        assert_eq!(check.latest.as_deref(), Some("1.5.0"));
        assert!(!check.up_to_date);
    }

    #[test]
    fn audit_detects_missing_shim_and_path_conflicts() {
        let root = std::env::temp_dir().join(format!("flowdeck-audit-{}", std::process::id()));
        let other_root =
            std::env::temp_dir().join(format!("flowdeck-audit-other-{}", std::process::id()));
        let shim_dir = root.join("bin");
        let other_dir = other_root.join("bin");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        // 主工具全部生成，才可能做到「无警告」
        for tool in AUDIT_WARN_TOOLS {
            std::fs::write(shim_dir.join(format!("{tool}{suffix}")), b"").unwrap();
        }
        std::fs::write(other_dir.join(format!("node{suffix}")), b"").unwrap();

        // 只有 shim：托管生效，不应告警
        let audit = audit_with_path(&shim_dir, &[shim_dir.clone()]);
        let node = audit.tools.iter().find(|t| t.tool == "node").unwrap();
        assert!(node.shim_exists);
        assert!(node.managed);
        assert_eq!(node.hits.len(), 1);
        assert!(
            audit.warnings.is_empty(),
            "unexpected: {:?}",
            audit.warnings
        );

        // 系统副本排在 shim 之前：实际生效不是 Vite+，应明确告警
        let audit = audit_with_path(&shim_dir, &[other_dir.clone(), shim_dir.clone()]);
        let node = audit.tools.iter().find(|t| t.tool == "node").unwrap();
        assert_eq!(node.hits.len(), 2);
        assert!(!node.managed);
        assert_eq!(node.foreign_hits.len(), 1);
        assert!(audit
            .warnings
            .iter()
            .any(|w| w.contains("系统安装可能优先生效")));

        // Vite+ 的 js_runtime 排在 shim 之前：仍算托管，不应误报系统优先
        let runtime_dir = root.join("js_runtime").join("node").join("26.13.0");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        std::fs::write(runtime_dir.join(format!("node{suffix}")), b"").unwrap();
        let audit = audit_with_path(&shim_dir, &[runtime_dir, shim_dir.clone()]);
        let node = audit.tools.iter().find(|t| t.tool == "node").unwrap();
        assert!(node.managed, "vp 自己的 runtime 不应算系统副本");
        assert!(
            audit.warnings.is_empty(),
            "unexpected: {:?}",
            audit.warnings
        );

        // shim 缺失：应给出生成建议，且 npx 等次要工具不产生警告
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let audit = audit_with_path(&empty, &[other_dir.clone()]);
        assert!(audit
            .warnings
            .iter()
            .any(|w| w.contains("shim 缺失") && w.contains("node")));
        assert!(audit
            .warnings
            .iter()
            .all(|w| !w.contains("npx") && !w.contains("bunx") && !w.contains("pnpx")));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&other_root).ok();
    }

    #[test]
    fn install_dir_count_ignores_launcher_extensions() {
        let hits = vec![
            r"C:\tools\node\npm".to_string(),
            r"C:\tools\node\npm.cmd".to_string(),
            r"C:\tools\node\npm.bat".to_string(),
        ];
        assert_eq!(distinct_install_dirs(&hits).len(), 1);

        let hits = vec![
            r"C:\tools\node\npm.cmd".to_string(),
            r"C:\other\node\npm.cmd".to_string(),
        ];
        assert_eq!(distinct_install_dirs(&hits).len(), 2);
    }

    #[cfg(windows)]
    #[test]
    fn same_dir_launchers_do_not_warn_as_multiple_copies() {
        let root = std::env::temp_dir().join(format!("flowdeck-audit-ext-{}", std::process::id()));
        let other_root =
            std::env::temp_dir().join(format!("flowdeck-audit-ext-other-{}", std::process::id()));
        let shim_dir = root.join("bin");
        let other_dir = other_root.join("node");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(&other_dir).unwrap();
        for tool in AUDIT_WARN_TOOLS {
            std::fs::write(shim_dir.join(format!("{tool}.exe")), b"").unwrap();
        }
        // 同一个系统 Node 安装同时提供 npm.exe / npm.cmd / npm.bat
        for name in ["npm.exe", "npm.cmd", "npm.bat"] {
            std::fs::write(other_dir.join(name), b"").unwrap();
        }

        let audit = audit_with_path(&shim_dir, &[shim_dir.clone(), other_dir.clone()]);
        let npm = audit.tools.iter().find(|t| t.tool == "npm").unwrap();
        assert_eq!(npm.foreign_hits.len(), 3);
        assert!(
            audit.warnings.iter().all(|w| !w.contains("不同终端")),
            "unexpected: {:?}",
            audit.warnings
        );

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&other_root).ok();
    }

    // ------------------------------------------------ vp 副本分类单测

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowdeck-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vp_file(dir: &Path) -> PathBuf {
        if cfg!(windows) {
            dir.join("vp.exe")
        } else {
            dir.join("vp")
        }
    }

    fn write_manifest(dir: &Path, text: &str) {
        std::fs::write(dir.join("package.json"), text).unwrap();
    }

    fn make_cand(
        path: &Path,
        version: &str,
        scope: &str,
        root: Option<&Path>,
        project: Option<&Path>,
        primary: bool,
    ) -> VpCandidate {
        VpCandidate {
            path: path.to_string_lossy().to_string(),
            version: Some(version.to_string()),
            scope: scope.to_string(),
            global_root: root.map(|p| p.to_string_lossy().to_string()),
            project: project.map(|p| p.to_string_lossy().to_string()),
            primary,
        }
    }

    #[test]
    fn classifies_project_dependency_and_known_global_root() {
        let project = temp_dir("cand-project");
        let bin_dir = project.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        write_manifest(&project, r#"{"devDependencies":{"vite-plus":"1.4.0"}}"#);
        let local = vp_file(&bin_dir);
        std::fs::write(&local, b"").unwrap();

        let global_root = temp_dir("cand-global");
        let global_bin = global_root.join("bin");
        std::fs::create_dir_all(&global_bin).unwrap();
        let global = vp_file(&global_bin);
        std::fs::write(&global, b"").unwrap();

        let roots = vec![global_root.clone()];
        let dirs = vec![global_bin.clone(), bin_dir.clone()];

        let (scope, groot, prj) = scope_of(&local, &roots, &dirs);
        assert_eq!(scope, "project");
        assert_eq!(prj.as_deref(), Some(project.to_string_lossy().as_ref()));
        assert!(groot.is_none());

        let (scope, groot, prj) = scope_of(&global, &roots, &dirs);
        assert_eq!(scope, "global");
        assert_eq!(
            groot.as_deref(),
            Some(global_root.to_string_lossy().as_ref())
        );
        assert!(prj.is_none());

        // 项目依赖版本与全局不同属于预期行为，不应告警
        let list = vec![
            make_cand(&global, "1.4.0", "global", Some(&global_root), None, true),
            make_cand(&local, "1.3.0", "project", None, Some(&project), false),
        ];
        let warnings = copy_warnings_for(&global, &list, &dirs);
        assert!(warnings.is_empty(), "unexpected: {warnings:?}");

        std::fs::remove_dir_all(&project).ok();
        std::fs::remove_dir_all(&global_root).ok();
    }

    #[test]
    fn classifies_pnpm_and_yarn_layouts() {
        let project = temp_dir("cand-pnpm");
        write_manifest(&project, r#"{"dependencies":{"vite-plus":"1.4.0"}}"#);
        let pnpm_dir = project
            .join("node_modules")
            .join(".pnpm")
            .join("vite-plus@1.4.0")
            .join("node_modules")
            .join("vite-plus")
            .join("bin");
        std::fs::create_dir_all(&pnpm_dir).unwrap();
        let pnpm_vp = vp_file(&pnpm_dir);
        std::fs::write(&pnpm_vp, b"").unwrap();
        let (scope, _, prj) = scope_of(&pnpm_vp, &[], &[]);
        assert_eq!(scope, "project");
        assert_eq!(prj.as_deref(), Some(project.to_string_lossy().as_ref()));

        let yarn_project = temp_dir("cand-yarn");
        write_manifest(
            &yarn_project,
            r#"{"devDependencies":{"vite-plus":"1.4.0"}}"#,
        );
        let yarn_dir = yarn_project.join(".yarn").join("sdks");
        std::fs::create_dir_all(&yarn_dir).unwrap();
        let yarn_vp = vp_file(&yarn_dir);
        std::fs::write(&yarn_vp, b"").unwrap();
        let (scope, _, prj) = scope_of(&yarn_vp, &[], &[]);
        assert_eq!(scope, "project");
        assert_eq!(
            prj.as_deref(),
            Some(yarn_project.to_string_lossy().as_ref())
        );

        std::fs::remove_dir_all(&project).ok();
        std::fs::remove_dir_all(&yarn_project).ok();
    }

    #[test]
    fn dedupes_aliases_and_paired_binaries() {
        let dir = temp_dir("cand-dedupe");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = vp_file(&bin);
        std::fs::write(&exe, b"").unwrap();
        let mut paths = vec![
            exe.clone(),
            bin.join("..").join("bin").join(exe.file_name().unwrap()),
        ];
        if cfg!(windows) {
            let cmd = bin.join("vp.cmd");
            std::fs::write(&cmd, b"").unwrap();
            paths.push(cmd);
            paths.push(PathBuf::from(format!("\\\\?\\{}", exe.display())));
        }
        let out = dedupe_candidates(paths);
        assert_eq!(out.len(), 1, "aliases should collapse: {out:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn warns_when_another_global_install_shadows_the_shim() {
        let root_a = temp_dir("cand-order-a");
        let bin_a = root_a.join("bin");
        let root_b = temp_dir("cand-order-b");
        let bin_b = root_b.join("bin");
        std::fs::create_dir_all(&bin_a).unwrap();
        std::fs::create_dir_all(&bin_b).unwrap();
        let primary = vp_file(&bin_a);
        let other = vp_file(&bin_b);
        std::fs::write(&primary, b"").unwrap();
        std::fs::write(&other, b"").unwrap();

        let list = vec![
            make_cand(&primary, "1.4.0", "global", Some(&root_a), None, true),
            make_cand(&other, "1.4.0", "global", Some(&root_b), None, false),
        ];
        let warnings = copy_warnings_for(&primary, &list, &[bin_b.clone(), bin_a.clone()]);
        assert!(
            warnings.iter().any(|w| w.contains("PATH 顺序被覆盖")),
            "unexpected: {warnings:?}"
        );
        // 顺序正常时（同版本）不应告警
        let warnings = copy_warnings_for(&primary, &list, &[bin_a.clone(), bin_b.clone()]);
        assert!(warnings.is_empty(), "unexpected: {warnings:?}");

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }

    #[test]
    fn ignores_unknown_sources_and_same_version_copies() {
        let root_a = temp_dir("cand-same-a");
        let bin_a = root_a.join("bin");
        let root_b = temp_dir("cand-same-b");
        let bin_b = root_b.join("bin");
        let unknown_dir = temp_dir("cand-unknown");
        for dir in [&bin_a, &bin_b, &unknown_dir] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let primary = vp_file(&bin_a);
        let other = vp_file(&bin_b);
        let unknown = vp_file(&unknown_dir);
        for file in [&primary, &other, &unknown] {
            std::fs::write(file, b"").unwrap();
        }

        // 未知来源：不在已知全局根，也不在 PATH 中
        let (scope, _, _) = scope_of(&unknown, &[], &[]);
        assert_eq!(scope, "unknown");

        let list = vec![
            make_cand(&primary, "1.4.0", "global", Some(&root_a), None, true),
            make_cand(&other, "1.4.0", "global", Some(&root_b), None, false),
            make_cand(&unknown, "1.5.0", "unknown", None, None, false),
        ];
        let warnings = copy_warnings_for(&primary, &list, &[bin_a.clone(), bin_b.clone()]);
        assert!(warnings.is_empty(), "unexpected: {warnings:?}");

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
        std::fs::remove_dir_all(&unknown_dir).ok();
    }

    #[test]
    fn warns_on_conflicting_global_versions_and_residuals() {
        let root_a = temp_dir("cand-conflict-a");
        let bin_a = root_a.join("bin");
        let versions_a = root_a.join("versions").join("1.2.0");
        let root_b = temp_dir("cand-conflict-b");
        let bin_b = root_b.join("bin");
        for dir in [&bin_a, &versions_a, &bin_b] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let primary = vp_file(&bin_a);
        let other = vp_file(&bin_b);
        let residual = vp_file(&versions_a);
        for file in [&primary, &other, &residual] {
            std::fs::write(file, b"").unwrap();
        }

        // 两个全局安装版本不同
        let list = vec![
            make_cand(&primary, "1.4.0", "global", Some(&root_a), None, true),
            make_cand(&other, "1.5.0", "global", Some(&root_b), None, false),
        ];
        let warnings = copy_warnings_for(&primary, &list, &[bin_a.clone(), bin_b.clone()]);
        assert!(
            warnings.iter().any(|w| w.contains("全局安装冲突")),
            "unexpected: {warnings:?}"
        );

        // 同一安装根残留多个版本
        let list = vec![
            make_cand(&primary, "1.4.0", "global", Some(&root_a), None, true),
            make_cand(&residual, "1.2.0", "global", Some(&root_a), None, false),
        ];
        let warnings = copy_warnings_for(&primary, &list, &[bin_a.clone()]);
        assert!(
            warnings.iter().any(|w| w.contains("多个版本残留")),
            "unexpected: {warnings:?}"
        );

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }
}
