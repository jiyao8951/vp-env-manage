use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 手动指定的 vp 可执行文件路径，为空时自动探测
    #[serde(default)]
    pub vp_path: Option<String>,
    /// 上一次执行 Pin / Doctor 的项目目录
    #[serde(default)]
    pub last_project_dir: Option<String>,
    /// 窗口是否始终置顶，默认关闭
    #[serde(default)]
    pub always_on_top: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vp_path: None,
            last_project_dir: None,
            always_on_top: false,
        }
    }
}

/// 配置的唯一内存态。所有读写都经过这里的锁：
/// 并发保存不会各自 `load → 改 → save` 而造成丢更新。
pub struct ConfigStore {
    cached: Mutex<Option<Config>>,
}

impl ConfigStore {
    pub fn new() -> Self {
        Self {
            cached: Mutex::new(None),
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, Option<Config>> {
        // 锁中毒时继续使用内部值：配置读写不应因为某次 panic 而彻底失效
        self.cached.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录 {:?}: {e}", dir))?;
    Ok(dir.join("config.json"))
}

pub fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// 读取磁盘配置。文件不存在时返回默认值；解析失败时不覆盖任何文件，
/// 原文件与已有备份都保留，交由前端提供「恢复 / 打开目录」的选择。
pub fn load_from(path: &Path) -> Result<Config, String> {
    if !path.exists() {
        return Ok(Config::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取配置失败 {:?}: {e}", path))?;
    serde_json::from_str::<Config>(&raw)
        .map_err(|e| format!("配置文件解析失败（已保留原文件 {:?}）: {e}", path))
}

fn temp_path(path: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let name = format!(
        "{}.{}.{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("config.json"),
        std::process::id(),
        n
    );
    path.with_file_name(name)
}

/// 进程内所有配置写入串行化，避免同进程多线程互相踩临时文件。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Windows 下另一个进程 / 线程短暂持有目标文件时 rename 会报“拒绝访问 / 共享冲突”，
/// 这里做少量重试；仍然失败则把错误交给调用方。
fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    for attempt in 0..10 {
        match fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let transient = matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33));
                if transient && attempt < 9 {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                return Err(e);
            }
        }
    }
    unreachable!()
}

/// 原子落盘：先写同目录临时文件并回读校验，再把上一份可解析的配置备份为 `.bak`，
/// 最后用 rename 覆盖，避免出现“写到一半”的截断文件。
pub fn save_to(path: &Path, config: &Config) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let raw = serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {e}"))?;
    // 写入前先确认这份内容能被自己读回来，避免把不可解析的数据落盘
    serde_json::from_str::<Config>(&raw).map_err(|e| format!("配置内容校验失败: {e}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录 {:?}: {e}", parent))?;
    }

    let tmp = temp_path(path);
    fs::write(&tmp, &raw).map_err(|e| format!("写入临时配置失败 {:?}: {e}", tmp))?;

    if path.exists() {
        // 只有旧文件本身可解析才备份：损坏文件不能覆盖掉上一份好备份
        let old_is_valid = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Config>(&text).ok())
            .is_some();
        if old_is_valid {
            let _ = fs::copy(path, backup_path(path));
        }
    }

    if let Err(e) = replace_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换配置文件失败 {:?}: {e}", path));
    }
    Ok(())
}

pub fn load(app: &tauri::AppHandle, store: &ConfigStore) -> Result<Config, String> {
    if let Some(cfg) = store.guard().clone() {
        return Ok(cfg);
    }
    let path = config_path(app)?;
    let cfg = load_from(&path)?;
    *store.guard() = Some(cfg.clone());
    Ok(cfg)
}

pub fn save(app: &tauri::AppHandle, store: &ConfigStore, config: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    save_to(&path, config)?;
    *store.guard() = Some(config.clone());
    Ok(())
}

pub fn backup_info(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let path = config_path(app)?;
    let backup = backup_path(&path);
    Ok(backup
        .exists()
        .then(|| backup.to_string_lossy().to_string()))
}

/// 用上一份备份替换当前配置（当前损坏时不会覆盖备份）。
pub fn restore_backup(app: &tauri::AppHandle, store: &ConfigStore) -> Result<Config, String> {
    let path = config_path(app)?;
    let backup = backup_path(&path);
    if !backup.exists() {
        return Err("没有可用的配置备份（config.json.bak）。".to_string());
    }
    let cfg = load_from(&backup).map_err(|e| format!("备份文件不可用: {e}"))?;
    save_to(&path, &cfg)?;
    *store.guard() = Some(cfg.clone());
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flowdeck-config-test-{}-{}-{}",
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

    fn sample(n: usize) -> Config {
        Config {
            last_project_dir: Some(format!("C:\\project{n}")),
            ..Config::default()
        }
    }

    #[test]
    fn atomic_save_creates_valid_file_and_backup() {
        let dir = temp_dir("atomic");
        let path = dir.join("config.json");
        save_to(&path, &sample(2)).unwrap();
        assert_eq!(load_from(&path).unwrap(), sample(2));

        save_to(&path, &sample(3)).unwrap();
        assert_eq!(load_from(&path).unwrap(), sample(3));
        // 上一份好配置被保留为备份
        assert_eq!(load_from(&backup_path(&path)).unwrap(), sample(2));
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_file_is_not_backed_up_over_good_backup() {
        let dir = temp_dir("corrupt");
        let path = dir.join("config.json");
        save_to(&path, &sample(1)).unwrap();
        save_to(&path, &sample(2)).unwrap(); // .bak = sample(1)
        fs::write(&path, "{ not json").unwrap();

        let err = load_from(&path).unwrap_err();
        assert!(err.contains("解析失败"));
        // 原文件仍在，且好备份没有被损坏内容覆盖
        assert_eq!(load_from(&backup_path(&path)).unwrap(), sample(1));

        save_to(&path, &sample(4)).unwrap(); // 旧文件不可解析 → 不备份
        assert_eq!(load_from(&backup_path(&path)).unwrap(), sample(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_leave_parseable_file() {
        let dir = temp_dir("concurrent");
        let path = dir.join("config.json");
        save_to(&path, &sample(0)).unwrap();
        let mut handles = Vec::new();
        for i in 0..8 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                for round in 0..10 {
                    let cfg = sample(i * 10 + round);
                    save_to(&path, &cfg).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let cfg = load_from(&path).unwrap();
        assert!(cfg.last_project_dir.is_some());
        // 文件不应残留临时文件
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
