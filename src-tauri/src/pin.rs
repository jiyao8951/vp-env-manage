//! 项目版本固定（pin）的只读解析、变更预览与备份。
//!
//! vp 支持的 pin 来源比 GUI 里展示的多：`.node-version`、`.nvmrc`、
//! `.nvmcp`，以及根 `package.json` 里的 `engines` / `volta` /
//! `packageManager` / `devEngines`。这里只读文件、不调用 vp，也不修改任何内容。

use serde::Serialize;
use semver::{Version, VersionReq};
use std::fs;
use std::path::{Path, PathBuf};

/// 向上扫描的最大层数（避免在异常目录结构里走太深）
const MAX_DEPTH: usize = 10;

const NODE_FILES: &[&str] = &[".nvmcp", ".node-version", ".nvmrc"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinEntry {
    pub path: String,
    pub dir: String,
    pub file: String,
    /// `node-version` / `nvmrc` / `package.json · engines.node` …
    pub kind: String,
    /// `node` / `npm` / `pnpm` / `yarn` / `bun`
    pub key: String,
    pub raw: String,
    pub value: String,
    /// 0 = 当前目录，1 = 一级上层
    pub depth: usize,
    /// 同一 key 最近的那一条
    pub effective: bool,
    /// 被哪条更近的 pin 覆盖
    pub shadowed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinConflict {
    pub key: String,
    pub dir: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinReport {
    pub cwd: String,
    /// 扫描到的最上层目录
    pub root: String,
    pub entries: Vec<PinEntry>,
    pub conflicts: Vec<PinConflict>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinChange {
    pub path: String,
    pub file: String,
    pub kind: String,
    /// create / update / remove / unchanged
    pub action: String,
    pub key: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// 预览为本地推断，实际写入以 `vp env pin` 输出为准
    pub predicted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PinBackup {
    pub dir: String,
    pub files: Vec<String>,
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\")
}

fn lower(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// 文件优先级：同一目录里更“专门”的 pin 文件优先
fn rank(file: &str) -> u8 {
    match file {
        ".nvmcp" => 0,
        ".node-version" => 1,
        ".nvmrc" => 2,
        _ => 3,
    }
}

fn key_name(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// pin 值的版本语义：具体版本、范围约束、或无法解析的字面量（lts / latest 等）
enum VersionSpec<'a> {
    Exact(Version),
    Range(&'a str),
    Other(&'a str),
}

/// `engines` 字段按 npm 语义始终是范围约束，即使写成 `24`（等价 `^24`）；
/// 其余来源（.nvmrc / devEngines / volta）是具体版本。
fn version_spec(entry: &PinEntry) -> VersionSpec<'_> {
    if entry.kind.starts_with("package.json · engines.") {
        return VersionSpec::Range(&entry.value);
    }
    match parse_exact_version(&entry.value) {
        Some(v) => VersionSpec::Exact(v),
        None if looks_like_range(&entry.value) => VersionSpec::Range(&entry.value),
        None => VersionSpec::Other(&entry.value),
    }
}

/// 解析 `26.13.0` / `26.13` / `26` 这类具体版本；范围写法返回 None
fn parse_exact_version(value: &str) -> Option<Version> {
    let text = value.trim().trim_start_matches('v');
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() > 3 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let mut nums = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        nums[i] = part.parse().ok()?;
    }
    Some(Version::new(nums[0], nums[1], nums[2]))
}

fn looks_like_range(value: &str) -> bool {
    value
        .chars()
        .any(|c| matches!(c, '<' | '>' | '=' | '^' | '~' | '*' | 'x' | 'X' | '|'))
        || value.split_whitespace().count() > 1
}

/// 把 npm 风格的范围（空格分隔比较符、`||`、`1.x`）转成 Rust semver 可解析的形式。
/// 连字符区间等暂不支持的写法返回 None，调用方按「无法证明一致」处理。
fn normalize_npm_range(branch: &str) -> Option<String> {
    let tokens: Vec<String> = branch
        .replace(',', " ")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let operators = ["<=", ">=", "<", ">", "=", "~", "^"];
    let mut merged: Vec<String> = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i].clone();
        if operators.contains(&token.as_str()) {
            let next = tokens.get(i + 1)?;
            merged.push(format!("{token}{next}"));
            i += 2;
            continue;
        }
        if token == "-" {
            return None;
        }
        merged.push(token);
        i += 1;
    }
    let out = merged
        .into_iter()
        .map(|token| {
            let lower = token.to_ascii_lowercase();
            if lower == "x" || lower == "*" {
                "*".to_string()
            } else if lower.ends_with(".x") {
                format!("{}.*", &token[..token.len() - 2])
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    Some(out)
}

/// 范围是否能覆盖某个具体版本；None 表示该写法无法解析、不能据此判定一致
fn range_covers(range: &str, version: &Version) -> Option<bool> {
    let mut parsed_any = false;
    for branch in range.split("||") {
        let Some(normalized) = normalize_npm_range(branch) else {
            continue;
        };
        let Ok(req) = VersionReq::parse(&normalized) else {
            continue;
        };
        parsed_any = true;
        if req.matches(version) {
            return Some(true);
        }
    }
    parsed_any.then_some(false)
}

/// 同一目录、同一 key 的多条 pin 是否真的冲突：
/// 范围若能覆盖具体版本（例如 engines `>=26.13.0` vs devEngines `26.13.0`）就视为一致；
/// 只有同类语义出现不同值才算冲突。
fn group_conflicts(entries: &[&PinEntry]) -> bool {
    let mut exacts: Vec<Version> = Vec::new();
    let mut ranges: Vec<&str> = Vec::new();
    let mut others: Vec<&str> = Vec::new();
    for entry in entries {
        match version_spec(entry) {
            VersionSpec::Exact(v) => exacts.push(v),
            VersionSpec::Range(r) => ranges.push(r),
            VersionSpec::Other(o) => others.push(o),
        }
    }

    // lts / latest 这类字面量无法按语义比较，沿用原来的字符串比较
    if !others.is_empty() {
        let mut values: Vec<&str> = entries.iter().map(|e| e.value.trim()).collect();
        values.sort_unstable();
        values.dedup();
        return values.len() > 1;
    }

    let mut distinct_exact: Vec<Version> = Vec::new();
    for version in &exacts {
        if !distinct_exact.contains(version) {
            distinct_exact.push(version.clone());
        }
    }
    if distinct_exact.len() > 1 {
        return true;
    }

    let mut distinct_ranges: Vec<String> = Vec::new();
    for range in &ranges {
        let key = range.split_whitespace().collect::<Vec<_>>().join(" ");
        if !distinct_ranges.contains(&key) {
            distinct_ranges.push(key);
        }
    }
    if distinct_ranges.len() > 1 {
        return true;
    }

    // 范围 + 具体版本：范围必须覆盖所有具体版本
    for range in &ranges {
        for version in &exacts {
            if !matches!(range_covers(range, version), Some(true)) {
                return true;
            }
        }
    }
    false
}

/// 读取单行版本文件，忽略空行与 `#` 注释
fn first_value(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.trim_start_matches('v').to_string())
}

fn push_text_entry(out: &mut Vec<PinEntry>, path: &Path, depth: usize, kind: &str, raw: String) {
    let value = raw.trim().trim_start_matches('v').to_string();
    out.push(PinEntry {
        path: norm(path),
        dir: norm(path.parent().unwrap_or(path)),
        file: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string(),
        kind: kind.to_string(),
        key: "node".to_string(),
        raw,
        value,
        depth,
        effective: false,
        shadowed_by: None,
    });
}

fn collect_package_json(
    out: &mut Vec<PinEntry>,
    path: &Path,
    depth: usize,
    warnings: &mut Vec<String>,
) {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            warnings.push(format!("无法读取 {}: {e}", norm(path)));
            return;
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("{} 解析失败，已跳过其 pin 字段: {e}", norm(path)));
            return;
        }
    };
    let file = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("package.json")
        .to_string();
    let mut push = |kind: &str, key: &str, raw: String| {
        out.push(PinEntry {
            path: norm(path),
            dir: norm(path.parent().unwrap_or(path)),
            file: file.clone(),
            kind: kind.to_string(),
            key: key_name(key),
            value: raw.trim().to_string(),
            raw,
            depth,
            effective: false,
            shadowed_by: None,
        });
    };

    for section in ["engines", "volta"] {
        if let Some(obj) = json.get(section).and_then(|v| v.as_object()) {
            for key in ["node", "npm", "pnpm", "yarn", "bun"] {
                if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                    if !v.trim().is_empty() {
                        push(
                            &format!("package.json · {section}.{key}"),
                            key,
                            v.to_string(),
                        );
                    }
                }
            }
        }
    }

    if let Some(pm) = json.get("packageManager").and_then(|v| v.as_str()) {
        if !pm.trim().is_empty() {
            let (name, version) = pm.split_once('@').unwrap_or((pm, ""));
            push("package.json · packageManager", name, version.to_string());
        }
    }

    if let Some(dev) = json.get("devEngines").and_then(|v| v.as_object()) {
        for (slot, value) in dev {
            let Some(obj) = value.as_object() else {
                continue;
            };
            let Some(name) = obj.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(version) = obj.get("version").and_then(|v| v.as_str()) else {
                continue;
            };
            if !version.trim().is_empty() {
                push(
                    &format!("package.json · devEngines.{slot}"),
                    name,
                    version.to_string(),
                );
            }
        }
    }
}

/// 从 cwd 向上扫描所有 pin 来源，并计算每个工具真正生效的那一条。
pub fn inspect(cwd: &Path) -> PinReport {
    let cwd = if cwd.is_dir() {
        cwd.to_path_buf()
    } else {
        PathBuf::from(cwd)
    };
    let cwd_text = norm(&cwd);
    let mut entries: Vec<PinEntry> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut root = cwd.clone();
    let mut dir: Option<&Path> = Some(cwd.as_path());

    for depth in 0..MAX_DEPTH {
        let Some(d) = dir else { break };
        root = d.to_path_buf();
        for name in NODE_FILES {
            let p = d.join(name);
            if p.is_file() {
                if let Ok(text) = fs::read_to_string(&p) {
                    if let Some(v) = first_value(&text) {
                        push_text_entry(&mut entries, &p, depth, name, v);
                    }
                }
            }
        }
        let pkg = d.join("package.json");
        if pkg.is_file() {
            collect_package_json(&mut entries, &pkg, depth, &mut warnings);
        }
        dir = d.parent();
    }

    // 越近越优先；同目录下专用文件优先
    entries.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then(rank(&a.file).cmp(&rank(&b.file)))
            .then(a.path.cmp(&b.path))
    });

    // 每个 key 取最近、优先级最高的一条作为生效值
    let keys = ["node", "npm", "pnpm", "yarn", "bun"];
    for key in keys {
        let mut winner: Option<usize> = None;
        for i in 0..entries.len() {
            if entries[i].key != key {
                continue;
            }
            match winner {
                None => {
                    entries[i].effective = true;
                    winner = Some(i);
                }
                Some(w) => {
                    let path = entries[w].path.clone();
                    entries[i].shadowed_by = Some(path);
                }
            }
        }
    }

    // 同目录同 key 出现语义不一致的值 → 冲突（例如 .nvmrc 与 engines.node 不一致）；
    // 范围与具体版本若兼容（engines `>=26.13.0` vs devEngines `26.13.0`）不算冲突
    let mut conflicts: Vec<PinConflict> = Vec::new();
    let mut seen: std::collections::HashMap<(String, String), Vec<&PinEntry>> =
        std::collections::HashMap::new();
    for e in &entries {
        seen.entry((lower(&e.dir), e.key.clone()))
            .or_default()
            .push(e);
    }
    for ((dir, key), group) in seen {
        if !group_conflicts(&group) {
            continue;
        }
        let mut values: Vec<String> = Vec::new();
        for e in group {
            if !values.contains(&e.value) {
                values.push(e.value.clone());
            }
        }
        conflicts.push(PinConflict {
            key,
            dir,
            values,
        });
    }

    // 上层目录的 pin 会命中所有子目录，必须显式提醒
    for e in &entries {
        if !e.effective {
            continue;
        }
        if e.depth > 0 {
            warnings.push(format!(
                "{} 的 {} = {} 来自上层目录（{}），会影响其下所有子目录（含当前项目）。",
                e.file, e.key, e.raw, e.dir
            ));
        }
    }
    if entries.iter().any(|e| !e.effective) {
        warnings.push(
            "同一工具有多处固定，界面按「最近目录优先、同目录专用文件优先」展示；实际以 vp env doctor 为准。"
                .to_string(),
        );
    }

    PinReport {
        cwd: cwd_text,
        root: norm(&root),
        entries,
        conflicts,
        warnings,
    }
}

/// 从 specs 里拆出 (工具名, 版本)
pub fn split_spec(spec: &str) -> (String, String) {
    let s = spec.trim();
    if let Some((name, ver)) = s.split_once('@') {
        if !name.trim().is_empty() {
            return (key_name(name), ver.trim().to_string());
        }
    }
    ("node".to_string(), s.trim_start_matches('v').to_string())
}

/// 向上找到最近的 package.json（用于 workspace 根）
fn workspace_manifest(cwd: &Path) -> PathBuf {
    let mut dir = Some(cwd);
    while let Some(d) = dir {
        let p = d.join("package.json");
        if p.is_file() {
            return p;
        }
        dir = d.parent();
    }
    cwd.join("package.json")
}

fn node_target_path(cwd: &Path, target: &str) -> PathBuf {
    match target {
        "nvmrc" => cwd.join(".nvmrc"),
        _ => cwd.join(".node-version"),
    }
}

fn read_optional(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// 预测 pin / unpin 会改动哪些文件与字段（不落盘）。
/// `target` 为空时按 vp 的自动策略推断：Node 写 `.node-version`，
/// 包管理器写 workspace 根 `package.json` 的 `packageManager`。
pub fn preview(
    cwd: &Path,
    specs: &[String],
    target: &str,
    unpin: bool,
) -> Result<Vec<PinChange>, String> {
    let specs: Vec<(String, String)> = specs
        .iter()
        .map(|s| split_spec(s))
        .filter(|(_, ver)| !ver.is_empty())
        .collect();
    if specs.is_empty() {
        return Err("请填写要固定的版本，例如 22.11.0、pnpm@10.18.0".to_string());
    }

    let text_target = matches!(target, "nvmrc" | "node-version");
    let manifest_target = matches!(target, "dev-engines" | "package-manager");
    let auto = target.is_empty();

    let node_specs: Vec<&(String, String)> = specs.iter().filter(|(k, _)| k == "node").collect();
    let pm_specs: Vec<&(String, String)> = specs.iter().filter(|(k, _)| k != "node").collect();

    let mut changes = Vec::new();

    if text_target || (auto && !node_specs.is_empty()) {
        if !pm_specs.is_empty() {
            return Err(format!(
                "{} 只能保存 Node 版本；包管理器版本请改用 package.json 目标。",
                if target == "nvmrc" {
                    ".nvmrc"
                } else {
                    ".node-version"
                }
            ));
        }
        let path = if text_target {
            node_target_path(cwd, target)
        } else {
            node_target_path(cwd, "node-version")
        };
        let file = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(".node-version")
            .to_string();
        let before = read_optional(&path).and_then(|t| first_value(&t));
        let after = node_specs.first().map(|(_, v)| v.clone());
        let action = if unpin {
            if before.is_some() {
                "remove"
            } else {
                "unchanged"
            }
        } else if before.is_none() {
            "create"
        } else if before.as_deref() == after.as_deref() {
            "unchanged"
        } else {
            "update"
        };
        changes.push(PinChange {
            path: norm(&path),
            file,
            kind: if target == "nvmrc" {
                "nvmrc"
            } else {
                "node-version"
            }
            .to_string(),
            key: "node".to_string(),
            action: action.to_string(),
            before,
            after: if unpin { None } else { after },
            predicted: true,
        });
    }

    if manifest_target
        || (auto && !pm_specs.is_empty())
        || (target == "dev-engines" && !node_specs.is_empty())
    {
        let path = workspace_manifest(cwd);
        let mut json: serde_json::Value = read_optional(&path)
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if !json.is_object() {
            return Err(format!("{} 不是 JSON 对象，无法预览。", norm(&path)));
        }
        let mut touched = false;
        let mut before_parts: Vec<String> = Vec::new();
        let mut after_parts: Vec<String> = Vec::new();

        for (name, version) in &specs {
            let (slot, old, new) = if *name == "node" {
                if target == "dev-engines" {
                    let old = json
                        .pointer("/devEngines/runtime/version")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    if !unpin {
                        json["devEngines"]["runtime"] =
                            serde_json::json!({ "name": "node", "version": version });
                    }
                    ("devEngines.runtime", old, version.clone())
                } else {
                    let old = json
                        .pointer("/engines/node")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    if unpin {
                        if let Some(obj) = json.get_mut("engines").and_then(|v| v.as_object_mut()) {
                            obj.remove("node");
                        }
                    } else {
                        json["engines"]["node"] = serde_json::json!(version);
                    }
                    ("engines.node", old, version.clone())
                }
            } else if target == "dev-engines" {
                let old = json
                    .pointer("/devEngines/packageManager/version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if !unpin {
                    json["devEngines"]["packageManager"] =
                        serde_json::json!({ "name": name, "version": version });
                }
                (
                    "devEngines.packageManager",
                    old,
                    format!("{name}@{version}"),
                )
            } else {
                let old = json
                    .get("packageManager")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if unpin {
                    if let Some(obj) = json.as_object_mut() {
                        obj.remove("packageManager");
                    }
                } else {
                    json["packageManager"] = serde_json::json!(format!("{name}@{version}"));
                }
                ("packageManager", old, format!("{name}@{version}"))
            };
            touched = true;
            before_parts.push(match old {
                Some(v) => format!("{slot} = {v}"),
                None => format!("{slot} = （未设置）"),
            });
            after_parts.push(if unpin {
                format!("{slot} = （移除）")
            } else {
                format!("{slot} = {new}")
            });
        }

        if touched {
            let file = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("package.json")
                .to_string();
            let existed = path.is_file();
            changes.push(PinChange {
                path: norm(&path),
                file,
                kind: if target == "dev-engines" {
                    "package.json · devEngines"
                } else {
                    "package.json · packageManager / engines"
                }
                .to_string(),
                key: "package".to_string(),
                action: if !existed {
                    if unpin {
                        "unchanged"
                    } else {
                        "create"
                    }
                } else {
                    "update"
                }
                .to_string(),
                before: Some(before_parts.join("\n")),
                after: Some(after_parts.join("\n")),
                predicted: true,
            });
        }
    }

    Ok(changes)
}

/// 把将要改动的文件复制到应用数据目录下的 `pin-backups/<stamp>/`。
/// 只允许复制已存在的普通文件，避免把目录或任意路径带进来。
pub fn backup(files: &[String], dest_root: &Path) -> Result<PinBackup, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = dest_root.join(format!("pin-backups/{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败 {:?}: {e}", dir))?;
    let mut saved = Vec::new();
    for (i, raw) in files.iter().enumerate() {
        let p = PathBuf::from(raw);
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("file");
        let target = dir.join(format!("{i}-{name}"));
        fs::copy(&p, &target).map_err(|e| format!("备份 {:?} 失败: {e}", p))?;
        saved.push(norm(&p));
    }
    Ok(PinBackup {
        dir: norm(&dir),
        files: saved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowdeck-pin-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn splits_specs() {
        assert_eq!(split_spec("22.11.0"), ("node".into(), "22.11.0".into()));
        assert_eq!(split_spec("node@22"), ("node".into(), "22".into()));
        assert_eq!(
            split_spec("pnpm@10.18.0"),
            ("pnpm".into(), "10.18.0".into())
        );
        assert_eq!(split_spec("lts"), ("node".into(), "lts".into()));
    }

    #[test]
    fn reads_first_non_comment_line() {
        assert_eq!(
            first_value("# comment\n\nv22.11.0\n"),
            Some("22.11.0".into())
        );
        assert_eq!(first_value("  "), None);
    }

    #[test]
    fn nearest_pin_wins_and_conflicts_are_reported() {
        let dir = temp_dir("inspect");
        let root = dir.join("root");
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(root.join(".nvmrc"), "20\n").unwrap();
        fs::write(child.join(".node-version"), "22\n").unwrap();
        fs::write(
            child.join("package.json"),
            r#"{"engines":{"node":"24"},"packageManager":"pnpm@10.18.0"}"#,
        )
        .unwrap();

        let report = inspect(&child);
        let node: Vec<&PinEntry> = report.entries.iter().filter(|e| e.key == "node").collect();
        assert_eq!(node.len(), 3);
        let effective = node.iter().filter(|e| e.effective).collect::<Vec<_>>();
        assert_eq!(effective.len(), 1);
        // 同目录专用文件优先于 package.json
        assert_eq!(effective[0].value, "22");
        assert!(report.conflicts.iter().any(|c| c.key == "node"));
        assert!(report.entries.iter().any(|e| !e.effective));
        // 上层目录的 pin 被更近的 pin 覆盖时，提示「同一工具有多处固定」
        assert!(report.warnings.iter().any(|w| w.contains("同一工具")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn range_and_exact_pins_are_compatible() {
        let dir = temp_dir("range-exact");
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("package.json"),
            r#"{"engines":{"node":">=26.13.0"},"devEngines":{"runtime":{"name":"node","version":"26.13.0"}}}"#,
        )
        .unwrap();

        // engines 的范围覆盖 devEngines 的具体版本 → 不是冲突
        let report = inspect(&project);
        assert!(
            report.conflicts.is_empty(),
            "unexpected: {:?}",
            report.conflicts
        );

        // 范围覆盖不到具体版本时仍应报冲突
        fs::write(
            project.join("package.json"),
            r#"{"engines":{"node":">=28"},"devEngines":{"runtime":{"name":"node","version":"26.13.0"}}}"#,
        )
        .unwrap();
        let report = inspect(&project);
        let node = report.conflicts.iter().find(|c| c.key == "node").unwrap();
        assert_eq!(node.values, vec![">=28".to_string(), "26.13.0".to_string()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn effective_pin_in_parent_directory_is_flagged() {
        let dir = temp_dir("inspect-parent");
        let root = dir.join("root");
        let child = root.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(root.join(".nvmrc"), "20\n").unwrap();
        let report = inspect(&child);
        let effective: Vec<&PinEntry> = report.entries.iter().filter(|e| e.effective).collect();
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].depth, 1);
        assert!(report.warnings.iter().any(|w| w.contains("上层目录")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_node_version_file() {
        let dir = temp_dir("preview-text");
        assert_eq!(
            preview(&dir, &["22".into()], "node-version", false).unwrap()[0].action,
            "create"
        );
        fs::write(dir.join(".node-version"), "20\n").unwrap();
        let changes = preview(&dir, &["22".into()], "node-version", false).unwrap();
        assert_eq!(changes[0].action, "update");
        assert_eq!(changes[0].before.as_deref(), Some("20"));
        assert_eq!(changes[0].after.as_deref(), Some("22"));
        let removed = preview(&dir, &["22".into()], "node-version", true).unwrap();
        assert_eq!(removed[0].action, "remove");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_package_json_target() {
        let dir = temp_dir("preview-pkg");
        fs::write(
            dir.join("package.json"),
            r#"{"packageManager":"pnpm@9.1.0"}"#,
        )
        .unwrap();
        let changes = preview(&dir, &["pnpm@10.18.0".into()], "package-manager", false).unwrap();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].before.as_deref().unwrap().contains("pnpm@9.1.0"));
        assert!(changes[0]
            .after
            .as_deref()
            .unwrap()
            .contains("pnpm@10.18.0"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_copies_existing_files_only() {
        let dir = temp_dir("backup");
        let f = dir.join(".nvmrc");
        fs::write(&f, "22\n").unwrap();
        let dest = dir.join("store");
        let out = backup(&[norm(&f), norm(&dir.join("missing"))], &dest).unwrap();
        assert_eq!(out.files.len(), 1);
        assert!(PathBuf::from(&out.dir).join("0-.nvmrc").is_file());
        let _ = fs::remove_dir_all(&dir);
    }
}
