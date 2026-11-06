mod config;
mod pin;
mod vp;

use std::path::Path;
use std::process::Command;

use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn_hidden(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

// ---------------------------------------------------------------- 配置读写

#[tauri::command]
fn load_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, config::ConfigStore>,
) -> Result<config::Config, String> {
    config::load(&app, &store)
}

#[tauri::command]
fn save_config(
    app: tauri::AppHandle,
    store: tauri::State<'_, config::ConfigStore>,
    config: config::Config,
) -> Result<(), String> {
    config::save(&app, &store, &config)
}

#[tauri::command]
fn config_dir(app: tauri::AppHandle) -> Result<String, String> {
    config::config_path(&app).map(|p| p.to_string_lossy().to_string())
}

/// 可恢复的配置备份路径（不存在时为 null）
#[tauri::command]
fn config_backup_info(app: tauri::AppHandle) -> Result<Option<String>, String> {
    config::backup_info(&app)
}

/// 用 config.json.bak 替换当前（损坏的）配置
#[tauri::command]
fn restore_config_backup(
    app: tauri::AppHandle,
    store: tauri::State<'_, config::ConfigStore>,
) -> Result<config::Config, String> {
    config::restore_backup(&app, &store)
}

// ------------------------------------------------------------ 启动与打开

/// Windows：直接调 `ShellExecuteW` 打开目标。
/// 之前走的是 `cmd /C start "" <target>`，cmd 会把 `&`、`|`、`^`、`%` 当成命令分隔符，
/// 带查询参数的网址（`?a=1&b=2`）会被从第一个 `&` 处截断；ShellExecute 没有这个问题，
/// 也不会闪一下控制台窗口。
#[cfg(windows)]
mod shell_exec {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut std::os::raw::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_cmd: i32,
        ) -> isize;
    }

    const SW_SHOWNORMAL: i32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub fn open(target: &str) -> Result<(), String> {
        let file = wide(target);
        // operation 传 NULL 即默认的「open」
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                std::ptr::null(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // 返回值 > 32 表示成功，<= 32 是错误码（SE_ERR_* 或 GetLastError 语义）
        if code > 32 {
            Ok(())
        } else {
            Err(format!("打开失败（ShellExecute 返回 {code}）：{target}"))
        }
    }
}

/// 用系统 shell 打开任意目标（URL、文件夹、快捷方式 .lnk、文档等）
fn shell_open(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        shell_exec::open(target)
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
}

/// 启动本地程序：可执行文件直接 spawn，其余交给系统 shell 关联打开
#[tauri::command]
fn launch_target(
    path: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("目标不存在：{path}"));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase();

    match ext.as_str() {
        "exe" | "com" | "bat" | "cmd" => {
            let mut cmd = Command::new(p);
            if let Some(a) = args {
                if !a.is_empty() {
                    cmd.args(a);
                }
            }
            if let Some(d) = cwd {
                if !d.trim().is_empty() {
                    cmd.current_dir(d);
                }
            }
            match spawn_hidden(&mut cmd) {
                Ok(_) => Ok(()),
                // 直接 spawn 失败（例如需要提权的快捷方式）时回退到 shell 打开
                Err(e) => {
                    let fallback = shell_open(&path);
                    if fallback.is_ok() {
                        Ok(())
                    } else {
                        Err(format!("启动失败: {e}"))
                    }
                }
            }
        }
        _ => shell_open(&path),
    }
}

/// 在默认浏览器中打开网址
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("网址为空".to_string());
    }
    let target = if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:")
        || trimmed.starts_with("ftp://")
    {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    shell_open(&target)
}

// --------------------------------------------------------------- Vite+ 环境

#[tauri::command]
fn vp_resolve(vp_path: Option<String>) -> Result<String, String> {
    vp::resolve(vp_path.as_deref()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn vp_version(vp_path: Option<String>) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || vp::version(&vp))
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?
}

#[derive(serde::Serialize)]
pub struct VpProbe {
    pub path: String,
    pub version: Option<String>,
    pub verified: bool,
    pub warnings: Vec<String>,
}

/// 设置页「检测」：只定位 + 校验身份，不安装、不升级。
#[tauri::command]
async fn vp_probe(vp_path: Option<String>) -> Result<VpProbe, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = vp::version(&vp).ok();
        let verified = raw
            .as_deref()
            .map(|text| vp::verify_identity(&vp, text).is_ok())
            .unwrap_or(false);
        VpProbe {
            path: vp.to_string_lossy().to_string(),
            version: raw.map(|text| vp::clean_version(&text)),
            verified,
            warnings: Vec::new(),
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))
}

/// 启动自检：确保 vp 存在且 >= 1.4.0。
/// `allow_mutation = false`（启动默认）只检测，不安装 / 不升级；
/// 用户点击「自动安装 / 升级」时传 true。每一步通过 `flowdeck:vp-status` 事件推给前端。
#[tauri::command]
async fn vp_ensure(
    app: tauri::AppHandle,
    vp_path: Option<String>,
    allow_mutation: Option<bool>,
) -> vp::EnsureResult {
    let allow = allow_mutation.unwrap_or(false);
    let app_for_events = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        vp::ensure(vp_path.as_deref(), allow, |phase, message| {
            let _ = app_for_events.emit(
                VP_STATUS_EVENT,
                serde_json::json!({ "phase": phase, "message": message }),
            );
        })
    })
    .await
    .unwrap_or_else(|e| vp::EnsureResult::failed(format!("Vite+ 自检任务失败：{e}")))
}

/// `vp env current --json`
#[tauri::command]
async fn vp_env_current(
    vp_path: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        vp::run_json(
            &vp,
            &["env".into(), "current".into(), "--json".into()],
            dir.as_deref(),
            vp::TIMEOUT_DEFAULT,
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env list [--json]`
#[tauri::command]
async fn vp_env_list(vp_path: Option<String>) -> Result<serde_json::Value, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        vp::run_json(
            &vp,
            &["env".into(), "list".into(), "--json".into()],
            None,
            vp::TIMEOUT_DEFAULT,
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env list-remote [selector] [--lts] [--all] --json`
#[tauri::command]
async fn vp_env_list_remote(
    vp_path: Option<String>,
    selector: Option<String>,
    lts: Option<bool>,
    all: Option<bool>,
) -> Result<serde_json::Value, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let args = vp::env_list_remote_args(
            selector.as_deref(),
            lts.unwrap_or(false),
            all.unwrap_or(false),
        );
        vp::run_json(&vp, &args, None, vp::TIMEOUT_REMOTE)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env install [spec]`（在项目目录执行）
/// 不带 spec 时安装项目解析出的完整环境（Node + 包管理器）。
/// 输出会按行推送 `flowdeck:env-phase`，前端据此展示 下载 / 解压 / 校验 阶段。
#[tauri::command]
async fn vp_env_install(
    app: tauri::AppHandle,
    vp_path: Option<String>,
    spec: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_install_args(spec.as_deref());
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        let app_for_events = app.clone();
        vp::run_with_progress(
            &vp,
            &args,
            dir.as_deref(),
            vp::TIMEOUT_BOOTSTRAP,
            &move |phase, message| {
                let _ = app_for_events.emit(
                    INSTALL_PHASE_EVENT,
                    serde_json::json!({ "phase": phase, "message": message }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env uninstall <spec>`
#[tauri::command]
async fn vp_env_uninstall(vp_path: Option<String>, spec: String) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        vp::run(
            &vp,
            &["env".into(), "uninstall".into(), spec],
            None,
            vp::TIMEOUT_LONG,
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env pin [spec...] [--target <target>] [--force] [--no-install]`（在指定项目目录执行）
#[tauri::command]
async fn vp_env_pin(
    vp_path: Option<String>,
    cwd: String,
    specs: Vec<String>,
    target: Option<String>,
    force: Option<bool>,
    no_install: Option<bool>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_pin_args(
            &specs,
            target.as_deref(),
            force.unwrap_or(false),
            no_install.unwrap_or(false),
        );
        let dir = PathBuf::from(cwd);
        vp::run(&vp, &args, Some(dir.as_path()), vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env unpin [scope] [--target <target>]`
#[tauri::command]
async fn vp_env_unpin(
    vp_path: Option<String>,
    cwd: String,
    scope: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_unpin_args(scope.as_deref(), target.as_deref());
        let dir = PathBuf::from(cwd);
        vp::run(&vp, &args, Some(dir.as_path()), vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env default [spec] [--unset]`
#[tauri::command]
async fn vp_env_default(
    vp_path: Option<String>,
    spec: Option<String>,
    unset: Option<bool>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_default_args(spec.as_deref(), unset.unwrap_or(false));
        vp::run(&vp, &args, None, vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env clean [selector]`
#[tauri::command]
async fn vp_env_clean(vp_path: Option<String>, selector: Option<String>) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_clean_args(selector.as_deref());
        vp::run(&vp, &args, None, vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env doctor [scope]`
#[tauri::command]
async fn vp_env_doctor(
    vp_path: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["env".into(), "doctor".into()];
        if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
            args.push(s);
        }
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        vp::run(&vp, &args, dir.as_deref(), vp::TIMEOUT_DEFAULT)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env which <tool>`：传入 cwd 才能命中项目里的 pin
#[tauri::command]
async fn vp_env_which(
    vp_path: Option<String>,
    tool: String,
    cwd: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        vp::run(
            &vp,
            &["env".into(), "which".into(), tool],
            dir.as_deref(),
            vp::TIMEOUT_DEFAULT,
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// 只读解析项目及上层目录的 pin 来源（不调用 vp，不改文件）
#[tauri::command]
fn pin_inspect(cwd: String) -> pin::PinReport {
    pin::inspect(Path::new(&cwd))
}

/// 预测 pin / unpin 会改动哪些文件与字段（本地推断，实际以 vp 输出为准）
#[tauri::command]
fn pin_preview(
    cwd: String,
    specs: Vec<String>,
    target: Option<String>,
    unpin: bool,
) -> Result<Vec<pin::PinChange>, String> {
    pin::preview(
        Path::new(&cwd),
        &specs,
        target.as_deref().unwrap_or(""),
        unpin,
    )
}

/// 写 pin 之前把目标文件复制到应用数据目录（自动备份）
#[tauri::command]
fn pin_backup(app: tauri::AppHandle, files: Vec<String>) -> Result<pin::PinBackup, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&root).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    pin::backup(&files, &root)
}

/// 取消当前运行中的 vp 命令（终止进程树并确认退出）
#[tauri::command]
fn vp_cancel() -> vp::CancelResult {
    vp::cancel_current()
}

/// doctor 的结构化版本：原始文本 + 分级条目 + 修复建议
#[tauri::command]
async fn vp_doctor_report(
    vp_path: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<vp::DoctorReport, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["env".into(), "doctor".into()];
        if let Some(s) = scope.filter(|s| !s.trim().is_empty()) {
            args.push(s);
        }
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        let (raw, succeeded) = match vp::run(&vp, &args, dir.as_deref(), vp::TIMEOUT_DEFAULT) {
            Ok(text) => (text, true),
            Err(e) => (e, false),
        };
        Ok::<_, String>(vp::parse_doctor_with_status(&raw, succeeded))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// which 的结构化版本：解析出的路径、是否存在与修复建议
#[tauri::command]
async fn vp_which_report(
    vp_path: Option<String>,
    tool: String,
    cwd: Option<String>,
) -> Result<vp::WhichReport, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        let raw = match vp::run(
            &vp,
            &["env".into(), "which".into(), tool.clone()],
            dir.as_deref(),
            vp::TIMEOUT_DEFAULT,
        ) {
            Ok(text) => text,
            Err(e) => e,
        };
        Ok::<_, String>(vp::parse_which(&tool, &raw))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// PATH / shim 审计：shim 是否生成、PATH 首个命中是不是 shim、是否有多副本。
/// 只读文件系统，不调用 vp；每次刷新实时读取，不缓存（避免终端里改了 PATH 后界面过期）。
#[tauri::command]
async fn env_path_audit(vp_path: Option<String>) -> Result<vp::PathAudit, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || Ok::<_, String>(vp::audit_path(&vp)))
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp upgrade --check`：只检查 Vite+ 自身是否有新版本，不改环境
#[tauri::command]
async fn vp_upgrade_check(vp_path: Option<String>) -> Result<vp::UpgradeCheck, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = match vp::run(
            &vp,
            &["upgrade".to_string(), "--check".to_string()],
            None,
            vp::TIMEOUT_REMOTE,
        ) {
            Ok(text) => text,
            Err(e) => e,
        };
        Ok::<_, String>(vp::parse_upgrade_check(&raw))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp upgrade`：升级 Vite+ 自身到最新版本（会改全局 CLI，需用户确认）
#[tauri::command]
async fn vp_upgrade_latest(
    app: tauri::AppHandle,
    vp_path: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let app_for_events = app.clone();
        vp::run_with_progress(
            &vp,
            &["upgrade".to_string()],
            None,
            vp::TIMEOUT_BOOTSTRAP,
            &move |phase, message| {
                let _ = app_for_events.emit(
                    VP_STATUS_EVENT,
                    serde_json::json!({ "phase": phase, "message": message }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp install`：在项目目录按 package.json 安装依赖（不是安装 Node / 包管理器）
#[tauri::command]
async fn vp_install_project(
    app: tauri::AppHandle,
    vp_path: Option<String>,
    cwd: String,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    let dir = PathBuf::from(cwd.trim());
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return Err("项目目录不存在，请重新选择后再试。".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let app_for_events = app.clone();
        vp::run_with_progress(
            &vp,
            &["install".to_string()],
            Some(dir.as_path()),
            vp::TIMEOUT_PROJECT,
            &move |phase, message| {
                let _ = app_for_events.emit(
                    INSTALL_PHASE_EVENT,
                    serde_json::json!({ "phase": phase, "message": message }),
                );
            },
        )
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env on|off [selector]`
#[tauri::command]
async fn vp_env_mode(
    vp_path: Option<String>,
    selector: Option<String>,
    managed: bool,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_mode_args(managed, selector.as_deref());
        vp::run(&vp, &args, None, vp::TIMEOUT_DEFAULT)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env setup [--refresh] [--env-only]`
#[tauri::command]
async fn vp_env_setup(
    vp_path: Option<String>,
    refresh: Option<bool>,
    env_only: Option<bool>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = vp::try_lock_env()?;
        let args = vp::env_setup_args(refresh.unwrap_or(false), env_only.unwrap_or(false));
        vp::run(&vp, &args, None, vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env print [selector]`：传入 cwd 才能反映项目里的 pin
#[tauri::command]
async fn vp_env_print(
    vp_path: Option<String>,
    selector: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["env".into(), "print".into()];
        if let Some(s) = selector.filter(|s| !s.trim().is_empty()) {
            args.push(s);
        }
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        vp::run(&vp, &args, dir.as_deref(), vp::TIMEOUT_DEFAULT)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env use <spec...> [--unset] [--no-install] [--silent-if-unchanged]`
/// —— 仅影响 Vite+ 自己的 shell 会话，GUI 中主要用于提示
#[tauri::command]
async fn vp_env_use(
    vp_path: Option<String>,
    specs: Vec<String>,
    unset: Option<bool>,
    no_install: Option<bool>,
    silent_if_unchanged: Option<bool>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let args = vp::env_use_args(
            &specs,
            unset.unwrap_or(false),
            no_install.unwrap_or(false),
            silent_if_unchanged.unwrap_or(false),
        );
        vp::run(&vp, &args, None, vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

/// `vp env exec [--node <spec>] [--npm <spec>] [--package-manager <spec>] <command...>`
#[tauri::command]
async fn vp_env_exec(
    vp_path: Option<String>,
    cwd: Option<String>,
    node: Option<String>,
    package_manager: Option<String>,
    npm: Option<String>,
    command: Vec<String>,
) -> Result<String, String> {
    let vp = vp::resolve(vp_path.as_deref())?;
    if command.is_empty() {
        return Err("请先填写要执行的命令".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["env".into(), "exec".into()];
        if let Some(n) = node.filter(|s| !s.trim().is_empty()) {
            args.push("--node".into());
            args.push(n);
        }
        // --npm 是 --package-manager npm@<version> 的简写
        if let Some(n) = npm.filter(|s| !s.trim().is_empty()) {
            args.push("--npm".into());
            args.push(n);
        }
        if let Some(p) = package_manager.filter(|s| !s.trim().is_empty()) {
            args.push("--package-manager".into());
            args.push(p);
        }
        args.extend(command);
        let dir = cwd.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        vp::run(&vp, &args, dir.as_deref(), vp::TIMEOUT_LONG)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
}

// ---------------------------------------------------- 窗口与单实例

/// 启动自检 / 安装 / 升级 Vite+ 的步骤进度
const VP_STATUS_EVENT: &str = "flowdeck:vp-status";
/// 安装过程中的阶段进度（下载 / 解压 / 校验）
const INSTALL_PHASE_EVENT: &str = "flowdeck:env-phase";

/// 唤出主窗口：二次启动时由单实例插件回调调用
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------ 窗口命令

/// 置顶开关
#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 真正退出程序（设置页的「退出」按钮）
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 固定画布尺寸（逻辑像素）。窗口不可拉伸，但小屏或高缩放比下若按 1200×660
/// 会超出显示器工作区，就按工作区上限收缩，避免窗口比屏幕还大。
fn enforce_fixed_size(window: &tauri::WebviewWindow) {
    const DESIGN_W: f64 = 1200.0;
    const DESIGN_H: f64 = 660.0;

    let mut width = DESIGN_W;
    let mut height = DESIGN_H;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area = monitor.work_area();
            let max_w = area.size.width as f64 / scale;
            let max_h = area.size.height as f64 / scale;
            width = width.min(max_w);
            height = height.min(max_h);
        }
    }
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
    let _ = window.center();
}

// ------------------------------------------------------------------ 入口

use std::path::PathBuf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 必须第一个注册：二次启动时直接唤回已有窗口，而不是再起一个实例
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let store = handle.state::<config::ConfigStore>();
            let cfg = config::load(&handle, &store).unwrap_or_default();

            // 恢复「始终置顶」，并按显示器工作区校正固定画布尺寸
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.set_always_on_top(cfg.always_on_top);
                enforce_fixed_size(&w);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            config_dir,
            config_backup_info,
            restore_config_backup,
            launch_target,
            open_url,
            vp_resolve,
            vp_version,
            vp_probe,
            vp_ensure,
            vp_env_current,
            vp_env_list,
            vp_env_list_remote,
            vp_env_install,
            vp_env_uninstall,
            vp_env_pin,
            vp_env_unpin,
            vp_env_default,
            vp_env_clean,
            vp_env_doctor,
            vp_env_which,
            vp_env_mode,
            vp_env_setup,
            vp_env_print,
            vp_env_use,
            vp_env_exec,
            pin_inspect,
            pin_preview,
            pin_backup,
            vp_cancel,
            vp_doctor_report,
            vp_which_report,
            env_path_audit,
            vp_upgrade_check,
            vp_upgrade_latest,
            vp_install_project,
            set_always_on_top,
            quit_app
        ])
        .manage(config::ConfigStore::new())
        .build(tauri::generate_context!())
        .expect("启动 FlowDeck 失败")
        .run(|_app, event| {
            // 退出前结束仍在运行的 vp 子进程，避免“主进程已退出、子进程残留”
            if let tauri::RunEvent::Exit = event {
                let _ = vp::cancel_current();
            }
        });
}
