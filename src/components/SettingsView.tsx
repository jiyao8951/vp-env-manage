import { useEffect, useState } from "react";
import {
  configDir,
  envPathAudit,
  errText,
  launchTarget,
  quitApp,
  type Config,
  type PathAudit,
  type VpEnsureResult,
} from "../lib/api";
import { APP_NAME, APP_VERSION } from "../lib/appMeta";
import type { Notify } from "../lib/envShared";
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
  notify: Notify;
  /** 切换窗口置顶（同时写配置） */
  onToggleAlwaysOnTop: () => void;
  vpPath: string | null;
  /** 启动自检结果：自动探测到的可执行文件与版本，只读展示 */
  ensure: VpEnsureResult | null;
  ensureBusy: boolean;
  onRecheck: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

/** 从完整可执行文件路径取所在目录（同时兼容 / 与 \ 分隔符） */
function dirnameOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

export default function SettingsView({
  config,
  notify,
  onToggleAlwaysOnTop,
  vpPath,
  ensure,
  ensureBusy,
  onRecheck,
  theme,
  onThemeChange,
}: Props) {
  const [dir, setDir] = useState<string>("");
  const [audit, setAudit] = useState<PathAudit | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  /** 配置目录直接展示，不需要先点一次按钮 */
  useEffect(() => {
    void configDir()
      .then(setDir)
      .catch((e) => notify("error", "读取配置目录失败", errText(e)));
  }, [notify]);

  /** 只读审计：每次自检结果变化后重新读取 PATH 中的 vp 副本，不缓存 */
  useEffect(() => {
    let alive = true;
    void envPathAudit(vpPath)
      .then((a) => {
        if (alive) {
          setAudit(a);
          setAuditError(null);
        }
      })
      .catch((e) => {
        if (alive) setAuditError(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [vpPath, ensure]);

  const vpDir = dirnameOf(ensure?.path);
  const copies = audit?.vp_candidates ?? [];
  const multiple = copies.length > 1;
  const verified = !!ensure?.ok && !!ensure?.compliant;

  return (
    <div className="env-view settings-view flow-view">
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
            <h4 className="section-title">Vite+ 可执行文件</h4>
            <span className="section-count">自动检测</span>
          </div>

          <div className="detail-list">
            <div className="detail-row">
              <span>所在目录</span>
              <code className="path-text ellipsis" title={vpDir ?? undefined}>
                {vpDir ?? (ensureBusy ? "检测中…" : "未找到")}
              </code>
            </div>
            <div className="detail-row">
              <span>可执行文件</span>
              <code className="path-text ellipsis" title={ensure?.path ?? undefined}>
                {ensure?.path ?? "—"}
              </code>
            </div>
            <div className="detail-row">
              <span>版本 / 状态</span>
              <span>
                {ensure?.version ? `v${ensure.version}` : "—"}
                <span className={`tag ${verified ? "ok" : "warn"}`} style={{ marginLeft: 8 }}>
                  {verified ? "已识别" : ensureBusy ? "检测中" : "未通过自检"}
                </span>
              </span>
            </div>
            <div className="detail-row">
              <span>PATH 中的副本</span>
              <span>{copies.length ? `${copies.length} 个` : audit ? "1 个" : "检测中…"}</span>
            </div>
          </div>

          {multiple ? (
            <div className="inline-warn danger" style={{ marginTop: 10 }}>
              检测到多个 vp 副本，不同终端可能解析到不同版本：
              {copies.map((c) => (
                <div key={c.path} className="muted small">
                  · {c.path}
                  {c.version ? ` (v${c.version})` : ""}
                  {c.primary ? " · 当前使用" : ""}
                </div>
              ))}
            </div>
          ) : null}

          {audit?.warnings.length ? (
            <div className="inline-warn" style={{ marginTop: 10 }}>
              {audit.warnings.join("；")}
            </div>
          ) : null}
          {auditError ? (
            <div className="inline-warn danger" style={{ marginTop: 10 }}>
              副本审计失败：{auditError}
            </div>
          ) : null}

          <div className="row settings-actions">
            <button className="btn" onClick={onRecheck} disabled={ensureBusy}>
              <Icon name="refresh" size={14} />
              {ensureBusy ? "检测中…" : "重新检测"}
            </button>
          </div>
          <div className="hint">
            可执行文件由应用自动探测并校验身份，无需手动指定。升级 Vite+ 请在命令行执行
            <code> vp upgrade</code>，客户端不再提供升级入口。
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
            <code className="input mono readonly" title={dir}>
              {dir || "读取中…"}
            </code>
            <button
              className="btn"
              disabled={!dir}
              onClick={() =>
                void launchTarget(dir).catch((e) => notify("error", "打开失败", errText(e)))
              }
            >
              <Icon name="external" size={14} />
              打开
            </button>
          </div>
          <div className="detail-list">
            <div className="detail-row">
              <span>配置文件</span>
              <code className="path-text">config.json</code>
            </div>
            <div className="detail-row">
              <span>自动备份</span>
              <code className="path-text">config.json.bak</code>
            </div>
          </div>
          <div className="hint">应用配置、自动备份都存放在这个目录。</div>
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
            基于 Vite+ <b>1.6.0</b> 的 <code>vp env</code>{" "}
            命令；「系统」管理全局环境，「项目」只作用于所选目录。
          </div>
        </div>
      </div>
    </div>
  );
}
