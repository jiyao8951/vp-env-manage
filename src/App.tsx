import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { APP_VERSION } from "./lib/appMeta";
import TitleBar from "./components/TitleBar";
import SystemView from "./components/SystemView";
import ProjectView from "./components/ProjectView";
import SettingsView from "./components/SettingsView";
import ConfigRecovery from "./components/ConfigRecovery";
import Toasts, { type Toast, type ToastKind } from "./components/Toasts";
import Icon, { type IconName } from "./components/Icon";
import { applyTheme, readThemeMode, saveThemeMode, type ThemeMode } from "./lib/theme";
import {
  configBackupInfo,
  configDir,
  emptyConfig,
  errText,
  launchTarget,
  loadConfig,
  restoreConfigBackup,
  saveConfig,
  setAlwaysOnTop,
  uid,
  vpEnsure,
  VP_STATUS_EVENT,
  type Config,
  type VpEnsureResult,
  type VpStatusPayload,
} from "./lib/api";

type View = "system" | "project" | "settings";

interface NavItem {
  id: View;
  label: string;
  /** 左侧导航轨上的短标签 */
  short: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { id: "system", label: "系统", short: "系统", icon: "layers" },
  { id: "project", label: "项目", short: "项目", icon: "pin" },
  { id: "settings", label: "设置", short: "设置", icon: "settings" },
];

const SUBTITLES: Record<View, string> = {
  system: "全局 Vite+ 环境管理",
  project: "所选项目的环境配置",
  settings: "设置",
};

/** 界面设计基准尺寸（逻辑像素），与 Rust 端初始窗口尺寸保持一致 */
const DESIGN_SIZE = { w: 1520, h: 940 };
/** 可用区域低于该值时布局会明显拥挤，提示用户调整分辨率 / 系统缩放 */
const MIN_VIEW = { w: 1480, h: 900 };

function ScreenSizeNotice({
  width,
  height,
  onClose,
}: {
  width: number;
  height: number;
  onClose: () => void;
}) {
  return (
    <div
      className="screen-warn"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="screen-warn-title"
    >
      <div className="screen-warn-card">
        <span className="screen-warn-icon" aria-hidden="true">
          <Icon name="alert" size={20} />
        </span>
        <h2 className="screen-warn-title" id="screen-warn-title">
          屏幕可用区域不足
        </h2>
        <p className="screen-warn-text">
          界面按{" "}
          <b>
            {DESIGN_SIZE.w} × {DESIGN_SIZE.h}
          </b>{" "}
          设计，当前可用区域为{" "}
          <b>
            {width} × {height}
          </b>{" "}
          （逻辑像素）。
        </p>
        <p className="screen-warn-text">
          建议使用 <b>1920 × 1080</b> 及以上分辨率，系统缩放保持 <b>100%</b>； 分辨率更高时（如 2560
          × 1440）缩放最高可到 <b>125%</b>。
        </p>
        <p className="screen-warn-note">继续使用时部分内容需要滚动，布局可能不够完整。</p>
        <button className="btn primary" onClick={onClose} autoFocus>
          仍要继续使用
        </button>
      </div>
    </div>
  );
}

function NavIcon({ item }: { item: NavItem }) {
  return <Icon name={item.icon} size={18} strokeWidth={1.6} />;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [view, setView] = useState<View>("system");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [vpEnsureResult, setVpEnsureResult] = useState<VpEnsureResult | null>(null);
  const [vpEnsureBusy, setVpEnsureBusy] = useState(false);
  const [vpEnsurePhase, setVpEnsurePhase] = useState<VpStatusPayload | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode());
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [sizeWarnClosed, setSizeWarnClosed] = useState(false);
  const ensureSeq = useRef(0);
  const startupChecked = useRef(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // 窗口不可拉伸，只有工作区装不下设计尺寸时才会被收缩，用于提示分辨率 / 缩放不达标
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const sizeTooSmall = viewport.w < MIN_VIEW.w || viewport.h < MIN_VIEW.h;

  const notify = useCallback((kind: ToastKind, title: string, text?: string) => {
    const id = uid();
    setToasts((prev) => [...prev, { id, kind, title, text }]);
    const t = window.setTimeout(
      () => setToasts((prev) => prev.filter((x) => x.id !== id)),
      kind === "error" ? 8000 : 2400,
    );
    timers.current.push(t);
  }, []);

  // Vite+ 版本适配事件：安装 / 升级可能持续几分钟，分步反馈当前进度
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<VpStatusPayload>(VP_STATUS_EVENT, (e) => {
      if (!disposed) setVpEnsurePhase(e.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * 检测 Vite+ 环境。默认只检测，不安装 / 升级；
   * 用户点击「自动安装 / 升级」时由调用方传 allowMutation = true。
   * 后端不缓存结果，手动「重新检测」也走同一路径，保证显示的是当前真实状态。
   */
  const runVpEnsure = useCallback(
    async (allowMutation = false) => {
      const runId = ++ensureSeq.current;
      setVpEnsureBusy(true);
      setVpEnsurePhase(null);
      try {
        const r = await vpEnsure(config?.vpPath ?? null, allowMutation);
        if (runId !== ensureSeq.current) return;
        setVpEnsureResult(r);
        if (!r.ok || !r.compliant) {
          notify("error", "Vite+ 环境自检失败", r.error ?? "请到设置页查看可执行文件信息");
        } else if (r.installed) {
          notify("success", "已安装 Vite+", `v${r.version ?? ""} 已就绪`);
        } else if (r.upgraded) {
          notify(
            "success",
            "已升级 Vite+",
            `${r.previous_version ? `v${r.previous_version}` : "旧版本"} → v${r.version ?? ""}`,
          );
        }
      } catch (e) {
        if (runId === ensureSeq.current) {
          setVpEnsureResult(null);
          notify("error", "Vite+ 环境自检失败", errText(e));
        }
      } finally {
        if (runId === ensureSeq.current) {
          setVpEnsureBusy(false);
          setVpEnsurePhase(null);
        }
      }
    },
    [config?.vpPath, notify],
  );

  /** 读取配置；失败时不回退到空配置，避免后续保存把用户数据覆盖掉。 */
  const loadConfigOnce = useCallback(async () => {
    try {
      const cfg = await loadConfig();
      const normalized = { ...emptyConfig(), ...cfg };
      setConfig(normalized);
      savedJson.current = JSON.stringify(normalized);
      setConfigError(null);
      setBackupPath(null);
    } catch (e) {
      setConfigError(errText(e));
      setConfig(null);
      try {
        setBackupPath(await configBackupInfo());
      } catch {
        setBackupPath(null);
      }
    }
  }, []);

  useEffect(() => {
    void loadConfigOnce();
  }, [loadConfigOnce]);

  // 主题：跟随系统时监听系统配色变化；显式浅 / 深色则直接应用
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [theme]);

  const changeTheme = useCallback((mode: ThemeMode) => {
    saveThemeMode(mode);
    setTheme(mode);
  }, []);

  // 启动只检测一次；不自动安装 / 升级（改动由用户在环境页确认）。
  useEffect(() => {
    if (!config || startupChecked.current) return;
    startupChecked.current = true;
    void runVpEnsure(false);
  }, [config, runVpEnsure]);

  // ---- 配置保存：立即更新界面，400ms 防抖后原子落盘；同一时刻只允许一个写入，
  // 写入期间的新改动会在本次结束后自动接续，避免旧快照覆盖新快照。
  const pendingRef = useRef<Config | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savingRef = useRef(false);
  const savedJson = useRef("");
  const flushRef = useRef<() => void>(() => {});

  const flushSave = useCallback(async () => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (savingRef.current) return;
    const next = pendingRef.current;
    if (!next) return;
    const json = JSON.stringify(next);
    if (json === savedJson.current) {
      pendingRef.current = null;
      return;
    }
    savingRef.current = true;
    try {
      await saveConfig(next);
      savedJson.current = json;
      if (pendingRef.current === next) pendingRef.current = null;
    } catch (e) {
      notify("error", "保存配置失败", errText(e));
    } finally {
      savingRef.current = false;
      if (pendingRef.current && JSON.stringify(pendingRef.current) !== savedJson.current) {
        window.setTimeout(() => flushRef.current(), 0);
      }
    }
  }, [notify]);
  flushRef.current = () => {
    void flushSave();
  };

  const persist = useCallback(
    async (next: Config) => {
      setConfig(next);
      pendingRef.current = next;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void flushSave();
      }, 400);
    },
    [flushSave],
  );

  // 关窗 / 切后台时尽力把最后一次改动写完（失败不打扰用户，下次启动仍可从配置读取）
  useEffect(() => {
    const onPageHide = () => {
      const pending = pendingRef.current;
      if (pending) void saveConfig(pending).catch(() => {});
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
  const patch = useCallback(
    (p: Partial<Config>) => {
      if (!config) return;
      void persist({ ...config, ...p });
    },
    [config, persist],
  );

  /** 切换窗口置顶：同时作用于窗口本身与配置 */
  const toggleAlwaysOnTop = useCallback(() => {
    if (!config) return;
    const next = !config.alwaysOnTop;
    void setAlwaysOnTop(next).catch((e) => notify("error", "切换置顶失败", errText(e)));
    void persist({ ...config, alwaysOnTop: next });
  }, [config, persist, notify]);

  const restoreBackup = useCallback(async () => {
    try {
      const cfg = await restoreConfigBackup();
      const normalized = { ...emptyConfig(), ...cfg };
      setConfig(normalized);
      savedJson.current = JSON.stringify(normalized);
      setConfigError(null);
      setBackupPath(null);
      notify("success", "已从备份恢复配置", "原损坏文件未被写入，备份保持原样");
    } catch (e) {
      notify("error", "恢复配置失败", errText(e));
    }
  }, [notify]);

  const openConfigFolder = useCallback(async () => {
    try {
      const dir = await configDir();
      await launchTarget(dir);
    } catch (e) {
      notify("error", "打开配置目录失败", errText(e));
    }
  }, [notify]);

  /* ------------------------------------------------------------------ UI */

  if (configError) {
    return (
      <ConfigRecovery
        error={configError}
        backupPath={backupPath}
        onReload={() => void loadConfigOnce()}
        onRestore={() => void restoreBackup()}
        onOpenFolder={() => void openConfigFolder()}
      />
    );
  }

  if (!config) {
    return (
      <div className="shell">
        <TitleBar />
        <div className="center-loading">
          <span className="spinner dark" />
          正在加载配置…
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <TitleBar
        subtitle={SUBTITLES[view]}
        alwaysOnTop={config.alwaysOnTop}
        onToggleAlwaysOnTop={toggleAlwaysOnTop}
      />
      <div className="workspace">
        <nav className="rail" aria-label="主导航">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`rail-item ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
              title={item.label}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span className="rail-icon">
                <NavIcon item={item} />
              </span>
              <span className="rail-label">{item.short}</span>
            </button>
          ))}
          <div className="rail-foot">v{APP_VERSION}</div>
        </nav>

        <main className="content content-env">
          {view === "settings" ? (
            <SettingsView
              config={config}
              notify={notify}
              onToggleAlwaysOnTop={toggleAlwaysOnTop}
              vpPath={config.vpPath ?? null}
              ensure={vpEnsureResult}
              ensureBusy={vpEnsureBusy}
              onRecheck={() => void runVpEnsure(false)}
              theme={theme}
              onThemeChange={changeTheme}
            />
          ) : view === "system" ? (
            <SystemView
              vpPath={config.vpPath ?? null}
              notify={notify}
              ensure={vpEnsureResult}
              ensureBusy={vpEnsureBusy}
              ensurePhase={vpEnsurePhase}
              onRecheck={() => void runVpEnsure(false)}
              onRepair={() => void runVpEnsure(true)}
            />
          ) : (
            <ProjectView
              vpPath={config.vpPath ?? null}
              projectDir={config.lastProjectDir ?? null}
              onProjectDirChange={(dir) => patch({ lastProjectDir: dir })}
              notify={notify}
            />
          )}
        </main>
      </div>
      <Toasts toasts={toasts} onClose={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
      {sizeTooSmall && !sizeWarnClosed ? (
        <ScreenSizeNotice
          width={viewport.w}
          height={viewport.h}
          onClose={() => setSizeWarnClosed(true)}
        />
      ) : null}
    </div>
  );
}
