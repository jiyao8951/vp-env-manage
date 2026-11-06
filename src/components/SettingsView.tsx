import { useState } from "react";
import {
  configDir,
  errText,
  launchTarget,
  pickVpBinary,
  quitApp,
  vpProbe,
  type Config,
} from "../lib/api";
import { APP_NAME, APP_VERSION } from "../lib/appMeta";
import type { ThemeMode } from "../lib/theme";
import Icon from "./Icon";
import LogoMark from "./Logo";

const THEMES: { id: ThemeMode; label: string; desc: string }[] = [
  { id: "system", label: "跟随系统", desc: "随 Windows 浅色 / 深色设置自动切换" },
  { id: "light", label: "浅色", desc: "默认的高对比浅色界面" },
  { id: "dark", label: "深色", desc: "低亮度环境下更舒适的深色界面" },
];

interface Props {
  config: Config;
  onPatch: (patch: Partial<Config>) => void;
  notify: (kind: "info" | "success" | "error", title: string, text?: string) => void;
  /** 切换窗口置顶（同时写配置） */
  onToggleAlwaysOnTop: () => void;
  /** vp 路径输入结束（失焦）或手动检测后，重新做一次只读自检 */
  onVpPathCommit: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

export default function SettingsView({
  config,
  onPatch,
  notify,
  onToggleAlwaysOnTop,
  onVpPathCommit,
  theme,
  onThemeChange,
}: Props) {
  const [dir, setDir] = useState<string>("");
  const [probing, setProbing] = useState(false);
  const [probeText, setProbeText] = useState<string>("");

  const showDir = async () => {
    try {
      setDir(await configDir());
    } catch (e) {
      notify("error", "读取配置目录失败", errText(e));
    }
  };

  const browseVp = async () => {
    const picked = await pickVpBinary();
    if (picked) onPatch({ vpPath: picked });
  };

  const probe = async () => {
    setProbing(true);
    try {
      const p = await vpProbe(config.vpPath);
      if (!p.verified) {
        const text = `已找到可执行文件，但无法确认是 Vite+：\n${p.path}\n请重新选择 vp.exe / vp.cmd。`;
        setProbeText(text);
        notify("error", "所选程序不是 Vite+", p.path);
        return;
      }
      setProbeText(
        [`vp ${p.version ?? "（无法读取版本）"}`, p.path, ...p.warnings].filter(Boolean).join("\n"),
      );
      notify("success", "已定位 Vite+", p.path);
      onVpPathCommit();
    } catch (e) {
      setProbeText(errText(e));
      notify("error", "未找到 vp", errText(e));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="env-view settings-view">
      <div className="page-head">
        <div className="page-title-row">
          <span className="page-icon">
            <Icon name="settings" size={18} />
          </span>
          <div>
            <h2 className="page-title">设置</h2>
            <p className="page-desc">配置存储于本机应用数据目录，不会随安装包带走。</p>
          </div>
        </div>
      </div>

      <div className="settings-grid">
        <div className="card settings-card">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="sparkles" size={14} />
            </span>
            <h4 className="section-title">外观</h4>
            <span className="section-count">仅影响界面</span>
          </div>

          <div className="theme-options" role="radiogroup" aria-label="配色主题">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={`theme-option ${theme === t.id ? "active" : ""}`}
                onClick={() => onThemeChange(t.id)}
              >
                <span className="theme-swatch" data-mode={t.id} aria-hidden="true" />
                <span className="theme-option-body">
                  <span className="theme-option-title">{t.label}</span>
                  <span className="theme-option-desc">{t.desc}</span>
                </span>
                {theme === t.id ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
          </div>
          <div className="hint">
            浅色 / 深色共用同一套语义化 token，主题只保存在本机浏览器存储。
          </div>
        </div>

        <div className="card settings-card">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="monitor" size={14} />
            </span>
            <h4 className="section-title">启动与窗口</h4>
            <span className="section-count">窗口行为</span>
          </div>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={config.alwaysOnTop}
              onChange={() => onToggleAlwaysOnTop()}
            />
            <span className="switch-text">
              <span className="switch-title">窗口始终置顶</span>
              <span className="switch-desc">常驻小面板时打开；也可用标题栏的置顶按钮切换。</span>
            </span>
          </label>

          <div className="row settings-actions">
            <button className="btn danger" onClick={() => void quitApp()}>
              退出 FlowDeck
            </button>
          </div>
          <div className="hint">关闭窗口即退出程序；重复启动只会唤出已有窗口，不会多开一份。</div>
        </div>

        <div className="card settings-card">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="bolt" size={14} />
            </span>
            <h4 className="section-title">Vite+（vp）可执行文件</h4>
            <span className="section-count">留空自动探测</span>
          </div>
          <div className="row">
            <input
              className="input mono"
              placeholder="留空则自动探测（PATH → ~/.vite-plus/bin）"
              value={config.vpPath ?? ""}
              onChange={(e) => onPatch({ vpPath: e.target.value || null })}
              onBlur={() => onVpPathCommit()}
            />
            <button className="btn" onClick={() => void browseVp()}>
              <Icon name="folder" size={14} />
              浏览
            </button>
            <button className="btn" disabled={probing} onClick={() => void probe()}>
              <Icon name="search" size={14} />
              {probing ? "检测中…" : "检测"}
            </button>
          </div>
          {probeText ? (
            <div className="console" style={{ marginTop: 10 }}>
              {probeText}
            </div>
          ) : null}
          <div className="hint">
            留空自动探测；打包后 PATH 中找不到 <code>vp</code> 时可手动指定。
          </div>
        </div>

        <div className="card settings-card">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="folder" size={14} />
            </span>
            <h4 className="section-title">数据</h4>
          </div>
          <div className="row">
            <button className="btn" onClick={() => void showDir()}>
              <Icon name="folder" size={14} />
              显示配置目录
            </button>
            {dir ? (
              <>
                <code className="input mono readonly">{dir}</code>
                <button
                  className="btn"
                  onClick={() =>
                    void launchTarget(dir).catch((e) => notify("error", "打开失败", errText(e)))
                  }
                >
                  <Icon name="external" size={14} />
                  打开
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="card settings-card settings-about">
          <div className="section-head">
            <span className="section-icon">
              <Icon name="info" size={14} />
            </span>
            <h4 className="section-title">关于</h4>
          </div>
          <div className="about-brand">
            <LogoMark size={38} />
            <div className="about-text">
              <div className="about-name">
                {APP_NAME}
                <span className="about-version">v{APP_VERSION}</span>
              </div>
              <div className="about-meta">Tauri 2 · React 19 · TypeScript 7 (tsgo)</div>
            </div>
          </div>
          <div className="hint">
            基于 Vite+ <b>1.4.0+</b> 的 <code>vp env</code> 命令；启动只检测， 安装 /
            升级需在环境页确认，不会自动修改全局环境。
          </div>
        </div>
      </div>
    </div>
  );
}
