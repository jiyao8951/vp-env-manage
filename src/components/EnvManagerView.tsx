import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  INSTALL_PHASE_EVENT,
  envPathAudit,
  errText,
  openUrl,
  pinBackup,
  pinInspect,
  pinPreview,
  pickProjectDir,
  launchTarget,
  splitCommand,
  vpCancel,
  vpEnvClean,
  vpEnvCurrent,
  vpEnvDefault,
  vpEnvExec,
  vpEnvInstall,
  vpEnvList,
  vpEnvListRemote,
  vpEnvMode,
  vpEnvPin,
  vpEnvPrint,
  vpEnvSetup,
  vpEnvUninstall,
  vpEnvUnpin,
  vpInstallProject,
  vpDoctorReport,
  vpUpgrade,
  vpUpgradeCheck,
  vpWhichReport,
  type PathAudit,
  type PinChange,
  type PinReport,
  type DoctorReport,
  type UpgradeCheck,
  type WhichReport,
  type VpCurrentResult,
  type VpEnsureResult,
  type VpInstalledItem,
  type VpListResult,
  type VpRemoteItem,
  type VpRemoteResult,
  type VpStatusPayload,
} from "../lib/api";
import { displayVersion, groupByMajor, parseSemver } from "../lib/version";
import { isNodeSpec } from "../lib/spec";
import { APP_VERSION } from "../lib/appMeta";
import ConsolePanel from "./ConsolePanel";
import EmptyState from "./EmptyState";
import Icon, { type IconName } from "./Icon";
import { OperationFeedback, OperationProgress } from "./OperationFeedback";
import StatusCard, { type StatusTone } from "./StatusCard";

/* --------------------------------------------------------------- 信息架构 */

export type EnvTab = "overview" | "env" | "project" | "diagnostics";

const TABS: { id: EnvTab; label: string; icon: IconName }[] = [
  { id: "overview", label: "概览", icon: "grid" },
  { id: "env", label: "环境", icon: "layers" },
  { id: "project", label: "项目", icon: "pin" },
  { id: "diagnostics", label: "诊断", icon: "shield" },
];

const SELECTORS: { id: string; label: string; isNode: boolean }[] = [
  { id: "node", label: "Node.js", isNode: true },
  { id: "pnpm", label: "pnpm", isNode: false },
  { id: "npm", label: "npm", isNode: false },
  { id: "yarn", label: "Yarn", isNode: false },
  { id: "bun", label: "Bun", isNode: false },
];

const PIN_TARGETS = [
  { id: "", label: "自动" },
  { id: "node-version", label: ".node-version" },
  { id: "nvmrc", label: ".nvmrc" },
  { id: "dev-engines", label: "devEngines" },
  { id: "package-manager", label: "packageManager" },
];

interface Props {
  vpPath: string | null;
  projectDir: string | null;
  onProjectDirChange: (dir: string) => void;
  notify: (kind: "info" | "success" | "error", title: string, text?: string) => void;
  /** App 启动时已完成的自检结果 */
  ensure: VpEnsureResult | null;
  ensureBusy: boolean;
  ensurePhase: VpStatusPayload | null;
  onRecheck: () => void;
  /** 用户明确同意安装 / 升级（会修改全局环境） */
  onRepair: () => void;
  /** 顶层导航直接控制当前标签页；不传时保留组件内的标签栏 */
  tab?: EnvTab;
  onTabChange?: (tab: EnvTab) => void;
}

/** Node.js 只保留这个大版本及之后的 LTS 线（更旧的维护起来没意义） */
const NODE_MIN_LTS_MAJOR = 18;

/** 当前环境 / 已安装清单的防抖窗口：仅用于合并「聚焦 + 可见」两次同时触发的刷新，
 * 不做实际缓存——终端里改了默认 / PATH 后，界面必须尽快反映真实状态。 */
const TTL_LOCAL = 2_000;
/** 远端版本列表缓存有效期 */
const TTL_REMOTE = 5 * 60_000;
/** 远端请求超过这个时间给出「网络较慢」提示（后端超时为 60s） */
const REMOTE_SLOW_MS = 20_000;

/**
 * 精简 Node.js 的远端版本列表：只留 18 及以后的 **LTS 版本**，
 * 外加当前**最新线**（例如 26.x，尚未进 LTS 也要留）。
 * 其余（17 及更旧、19/21/23/25 这类非 LTS 的奇数线）一律不展示。
 */
function filterNodeRemote(items: VpRemoteItem[]): VpRemoteItem[] {
  const majorOf = (i: VpRemoteItem) => parseSemver(i.version)[0];
  const latestMajor = items.find((i) => i.latest)?.version;
  const newest = latestMajor
    ? parseSemver(latestMajor)[0]
    : items.reduce((m, i) => Math.max(m, majorOf(i)), 0);
  return items.filter((i) => {
    const major = majorOf(i);
    return (i.lts ? major >= NODE_MIN_LTS_MAJOR : false) || major === newest;
  });
}

/** 生成带限定符的版本规范：node → `22.11.0`，包管理器 → `pnpm@10.18.0` */
function specFor(selector: string, version: string, bare: boolean): string {
  const v = displayVersion(version);
  if (selector === "node" && bare) return v;
  return `${selector}@${v}`;
}

/** 判断路径是否位于指定目录内（用于提示「会改到上层目录」） */
function pathInside(parent: string, child: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase();
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + "\\");
}

/** 远端版本列表离线缓存：成功后写入，失败时回退并标注缓存时间 */
const REMOTE_CACHE_PREFIX = "flowdeck.remote.";

function readRemoteCache(key: string): { at: number; data: VpRemoteResult } | null {
  try {
    const raw = localStorage.getItem(REMOTE_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; data?: VpRemoteResult };
    if (typeof parsed.at !== "number" || !parsed.data) return null;
    return { at: parsed.at, data: parsed.data };
  } catch {
    return null;
  }
}

function writeRemoteCache(key: string, data: VpRemoteResult) {
  try {
    localStorage.setItem(REMOTE_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* 存储配额不足时静默忽略，不影响在线结果 */
  }
}

/** 把安装 / 卸载失败粗分为网络、权限、磁盘、残留四类，给出可执行的下一步 */
function classifyFailure(message: string): { label: string; tip: string } {
  const s = message.toLowerCase();
  if (
    ["network", "econn", "enotfound", "timed out", "timeout", "网络", "getaddrinfo", "proxy"].some(
      (k) => s.includes(k),
    )
  ) {
    return {
      label: "网络失败",
      tip: "检查网络 / 代理后重试；若列表已有缓存，可先离线查看。",
    };
  }
  if (["eacces", "eperm", "denied", "permission", "权限", "拒绝访问"].some((k) => s.includes(k))) {
    return {
      label: "权限不足",
      tip: "确认安装目录可写，避免使用受保护的 Program Files；以当前用户重试。",
    };
  }
  if (["enospc", "no space", "disk", "磁盘", "空间不足", "quota"].some((k) => s.includes(k))) {
    return {
      label: "磁盘空间不足",
      tip: "清理磁盘后重试，或先执行 vp env clean 释放未使用的运行时。",
    };
  }
  if (
    ["busy", "in use", "occupied", "占用", "already", "exists", "残留", "lock"].some((k) =>
      s.includes(k),
    )
  ) {
    return {
      label: "文件占用 / 残留",
      tip: "先关闭正在使用该版本的程序或终端，再执行清理并重试。",
    };
  }
  return {
    label: "未知失败",
    tip: "可先执行 vp env list 核对状态，必要时清理未完成安装后重试。",
  };
}

function summarizeOp(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const picked = lines.filter((l) =>
    /^(✓|✔|File:|Field:|Updated\b|Pinned\b|Unpinned\b|Removed\b|No .*file|安装|升级)/.test(l),
  );
  return (picked.length ? picked : lines).slice(0, 8).join("\n");
}

const DIAG_TONE: Record<string, string> = {
  ok: "ok",
  warn: "warn",
  error: "danger",
  info: "neutral",
};

function DiagReportView({ report }: { report: DoctorReport }) {
  return (
    <div className="card diag-report">
      <div className={`diag-summary ${report.healthy ? "ok" : "danger"}`}>{report.summary}</div>
      {report.items.map((item, i) => (
        <div className={`diag-row ${item.level}`} key={`${i}-${item.text}`}>
          <span className={`badge ${DIAG_TONE[item.level] ?? "neutral"}`}>{item.level}</span>
          <div className="diag-row-main">
            <div className="diag-row-text">{item.text}</div>
            {item.suggestion ? (
              <div className="diag-suggestion">建议：{item.suggestion}</div>
            ) : null}
          </div>
        </div>
      ))}
      {report.items.length === 0 ? <div className="hint">vp 没有输出可识别的诊断条目。</div> : null}
      <details className="diag-raw">
        <summary>原始输出</summary>
        <pre>{report.raw}</pre>
      </details>
    </div>
  );
}

function WhichReportView({ report }: { report: WhichReport }) {
  return (
    <div className="card diag-report">
      <div className="diag-row">
        <span className={`badge ${report.exists ? "ok" : "danger"}`}>
          {report.exists ? "已找到" : "未找到"}
        </span>
        <div className="diag-row-main">
          <div className="diag-row-text">
            <strong>{report.tool}</strong> →{" "}
            <code className="path-text" title={report.path || undefined}>
              {report.path || "（无路径）"}
            </code>
          </div>
          {report.version || report.package ? (
            <div className="diag-row-text">
              {report.package ? <span>包：{report.package}</span> : null}
              {report.package && report.version ? <span className="muted"> · </span> : null}
              {report.version ? <span>版本：{report.version}</span> : null}
            </div>
          ) : null}
          {report.source ? (
            <div className="diag-row-text muted">
              来源：
              <code className="path-text" title={report.source}>
                {report.source}
              </code>
            </div>
          ) : null}
          {report.suggestion ? (
            <div className="diag-suggestion">建议：{report.suggestion}</div>
          ) : null}
        </div>
      </div>
      <details className="diag-raw">
        <summary>原始输出</summary>
        <pre>{report.raw}</pre>
      </details>
    </div>
  );
}

function clock(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 把 vp env current 返回的 mode 归一成可读状态 */
function modeInfo(mode?: string | null): { label: string; tone: StatusTone } {
  if (!mode) return { label: "未读取", tone: "neutral" };
  const s = mode.toLowerCase();
  if (s.includes("managed") || s.includes("vite")) return { label: "Vite+ 托管", tone: "ok" };
  if (s.includes("system") || s.includes("prefer")) return { label: "系统优先", tone: "warn" };
  return { label: mode, tone: "info" };
}

/** 比较路径时忽略大小写与斜杠差异 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/** 把 PATH 审计归一成“shim 到底有没有真的生效”，避免把 bin_path 误当成 shim */
function shimInfo(
  audit: PathAudit | null,
  mode: { label: string; tone: StatusTone },
): { label: string; tone: StatusTone; sub: string; detail?: string } {
  if (!audit) {
    return { label: mode.label, tone: mode.tone, sub: "正在审计 shim 与 PATH…" };
  }
  const node = audit.tools.find((t) => t.tool === "node");
  if (!node) {
    return {
      label: "未审计到 node",
      tone: "warn",
      sub: `shim 目录：${audit.shim_dir || "—"}`,
    };
  }
  if (!node.shim_exists) {
    return {
      label: "shim 缺失",
      tone: "danger",
      sub: `预期位置：${node.shim_path}`,
      detail: audit.shim_dir,
    };
  }
  if (node.hits.length === 0) {
    return {
      label: "PATH 未命中",
      tone: "warn",
      sub: "shim 已生成，但当前进程 PATH 里没有它",
      detail: node.shim_path,
    };
  }
  const first = node.hits[0];
  if (!node.managed) {
    return {
      label: "系统优先",
      tone: "warn",
      sub: `PATH 首命中：${first}`,
      detail: node.shim_path,
    };
  }
  return {
    label: samePath(first, node.shim_path) ? "托管已生效" : "托管已生效（runtime 直连）",
    tone: "ok",
    sub: `生效路径：${first}`,
    detail: audit.shim_dir,
  };
}

/** 状态卡的通用图标色，避免在 JSX 里散落魔法值 */
const TONE_ICON: Record<StatusTone, IconName> = {
  ok: "check",
  warn: "alert",
  danger: "alert",
  info: "info",
  neutral: "info",
};

function SkeletonCards({ rows = 2 }: { rows?: number }) {
  return (
    <div className="status-cards" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-card" key={i}>
          <span className="skeleton-line w-40" />
          <span className="skeleton-line w-70 tall" />
          <span className="skeleton-line w-55" />
        </div>
      ))}
    </div>
  );
}

function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <span className="skeleton-line w-100" key={i} />
      ))}
    </div>
  );
}

export default function EnvManagerView({
  tab: tabProp,
  onTabChange,
  vpPath,
  projectDir,
  onProjectDirChange,
  notify,
  ensure,
  ensureBusy,
  ensurePhase,
  onRecheck,
  onRepair,
}: Props) {
  const [innerTab, setInnerTab] = useState<EnvTab>("overview");
  const tab = tabProp ?? innerTab;
  const goTab = useCallback(
    (next: EnvTab) => {
      if (onTabChange) onTabChange(next);
      else setInnerTab(next);
    },
    [onTabChange],
  );
  const [envSection, setEnvSection] = useState<"installed" | "remote">("installed");
  const [current, setCurrent] = useState<VpCurrentResult | null>(null);
  const [installed, setInstalled] = useState<VpListResult | null>(null);
  const [remote, setRemote] = useState<VpRemoteResult | null>(null);
  const [remoteSelector, setRemoteSelector] = useState("node");
  const [ltsOnly, setLtsOnly] = useState(false);
  // vp 默认只返回「近期」版本，--all 才包含全部历史版本
  const [allRemote, setAllRemote] = useState(false);
  const [perMajor, setPerMajor] = useState(3);
  const [consoleText, setConsoleText] = useState("");
  const [consoleSource, setConsoleSource] = useState("");
  const [consoleAt, setConsoleAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [opCancelled, setOpCancelled] = useState(false);
  const [installStage, setInstallStage] = useState<{ phase: string; message: string } | null>(null);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [remoteStartedAt, setRemoteStartedAt] = useState<number | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pinTarget, setPinTarget] = useState("");
  const [pinForce, setPinForce] = useState(false);
  const [pinNoInstall, setPinNoInstall] = useState(false);
  const [pinSpecs, setPinSpecs] = useState("");
  /** 当前项目的 pin 只读解析结果（含上层目录与冲突） */
  const [pinReport, setPinReport] = useState<PinReport | null>(null);
  const [pinReportBusy, setPinReportBusy] = useState(false);
  /** pin / unpin 的 diff 预览（确认前不执行，也不写文件） */
  const [pinDraft, setPinDraft] = useState<{
    mode: "pin" | "unpin";
    specs: string[];
    target: string | null;
    changes: PinChange[];
    scope: string | null;
  } | null>(null);
  const [pinDraftBusy, setPinDraftBusy] = useState(false);
  const [lastBackupDir, setLastBackupDir] = useState<string | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>([]);
  const [whichTool, setWhichTool] = useState("node");
  const [execCmd, setExecCmd] = useState("");
  const [execNode, setExecNode] = useState("");
  const [execPm, setExecPm] = useState("");
  const [execNpm, setExecNpm] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installSpec, setInstallSpec] = useState("");
  const [tagDefault, setTagDefault] = useState("");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [whichReport, setWhichReport] = useState<WhichReport | null>(null);
  /** PATH / shim 实时审计结果（随每次刷新重新读取，不缓存） */
  const [pathAudit, setPathAudit] = useState<PathAudit | null>(null);
  /** vp 自身版本检查结果（用户主动检查后才有） */
  const [upgradeCheck, setUpgradeCheck] = useState<UpgradeCheck | null>(null);
  const [printRaw, setPrintRaw] = useState<string>("");
  const [unpinScope, setUnpinScope] = useState("");
  const [unpinTarget, setUnpinTarget] = useState("");
  /** 最近一次 pin / unpin / install 的关键输出（文件、字段、解析结果） */
  const [opResult, setOpResult] = useState<{ label: string; text: string } | null>(null);
  /** 最近一次失败的安装 spec，用于「清理残留并重试」 */
  const [lastInstallSpec, setLastInstallSpec] = useState<string | null>(null);
  const [remoteCachedAt, setRemoteCachedAt] = useState<number | null>(null);
  /** 远端大版本较多时先渲染前若干组，避免一次性铺开上百个节点 */
  const [showAllMajor, setShowAllMajor] = useState(false);
  /** 操作失败后的重试入口；提示“本地状态可能不一致” */
  const [opError, setOpError] = useState<{
    label: string;
    message: string;
    retry: () => Promise<string>;
  } | null>(null);

  const resolved = ensure?.path ?? "";
  const version = ensure?.version ? `vp v${ensure.version}` : "";
  const ensureOk = !!ensure?.ok && !!ensure?.compliant;
  const hasData = !!current || !!installed;

  /** 破坏性操作前弹原生确认框；非 Tauri 环境回退到浏览器 confirm */
  const confirm = async (message: string, title: string): Promise<boolean> => {
    try {
      return await ask(message, { title, kind: "warning" });
    } catch {
      return typeof window !== "undefined" && window.confirm(message);
    }
  };

  /** 读取当前环境、已安装清单与 PATH/shim 审计。
   * 2s TTL 合并「已经完成」的重复刷新；飞行中的请求按 key 复用，压掉「聚焦 + 可见」同帧双触发。
   * force = true 时立即重读且不复用飞行中的请求（操作刚改过环境，必须拿最新状态）。
   * 单项失败不再整页锁死；审计失败不影响主数据。 */
  const loadedKeyRef = useRef("");
  const loadedAtRef = useRef(0);
  /** 正在飞行中的一次本地刷新：同 key 的非强制刷新直接复用它 */
  const inflightRef = useRef<{ key: string; task: Promise<void> } | null>(null);
  /** 刷新请求序号：只有最后发起的那次才允许写回状态 */
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(
    async (force = false) => {
      const key = `${vpPath ?? ""}|${projectDir ?? ""}`;
      if (!force && loadedKeyRef.current === key && Date.now() - loadedAtRef.current < TTL_LOCAL) {
        return;
      }
      // 「窗口可见」事件与 window focus 会在同一帧各触发一次刷新，此时上一轮还没
      // 写回 loadedAtRef，TTL 拦不住第二次，会重复拉起 2 个 vp 进程和一次 PATH 审计。
      // 这里让同 key 的非强制刷新复用同一个请求；force 不复用，保证操作后拿到新状态。
      if (!force) {
        const running = inflightRef.current;
        if (running && running.key === key) return running.task;
      }
      const seq = ++refreshSeqRef.current;
      const task = (async () => {
        const [c, l, a] = await Promise.allSettled([
          vpEnvCurrent(vpPath, projectDir),
          vpEnvList(vpPath),
          envPathAudit(vpPath),
        ]);
        // 期间又发起了更新的刷新（例如操作完成后的强制刷新）：旧结果不能覆盖新状态
        if (seq !== refreshSeqRef.current) return;
        if (c.status === "fulfilled") setCurrent(c.value);
        if (l.status === "fulfilled") setInstalled(l.value);
        if (a.status === "fulfilled") setPathAudit(a.value);
        const failed = [c, l].find((r) => r.status === "rejected");
        setLoadError(failed && failed.status === "rejected" ? errText(failed.reason) : null);
        loadedKeyRef.current = key;
        loadedAtRef.current = Date.now();
        setLastLoadedAt(Date.now());
      })();
      inflightRef.current = { key, task };
      try {
        await task;
      } finally {
        if (inflightRef.current?.task === task) inflightRef.current = null;
      }
    },
    [vpPath, projectDir],
  );

  // 启动自检通过后才读取当前环境；vp 路径 / 项目目录变化时重新解析
  useEffect(() => {
    if (ensureOk) void refresh(false);
  }, [ensureOk, refresh]);

  // 远端列表：记录数据所属的 key 与失败 key，避免失败后 effect 无限重试
  const remoteSeq = useRef(0);
  const remoteKeyRef = useRef<string | null>(null);
  const remoteFailedKey = useRef<string | null>(null);
  const remoteAtRef = useRef(0);
  const remoteKey = `${remoteSelector}|${ltsOnly ? 1 : 0}|${allRemote ? 1 : 0}`;

  const resetRemote = useCallback(() => {
    // 让仍在飞行中的旧请求失效，避免它晚到后覆盖新选择器的数据
    remoteSeq.current += 1;
    setLoadingRemote(false);
    setRemoteStartedAt(null);
    setRemoteError(null);
    remoteFailedKey.current = null;
    remoteKeyRef.current = null;
    setRemote(null);
    setRemoteCachedAt(null);
    setShowAllMajor(false);
  }, []);

  const loadRemote = useCallback(
    async (force = false) => {
      const key = `${remoteSelector}|${ltsOnly ? 1 : 0}|${allRemote ? 1 : 0}`;
      if (!force && remoteKeyRef.current === key && Date.now() - remoteAtRef.current < TTL_REMOTE) {
        return;
      }
      const seq = ++remoteSeq.current;
      setLoadingRemote(true);
      setRemoteStartedAt(Date.now());
      setRemoteError(null);
      try {
        const data = await vpEnvListRemote(vpPath, remoteSelector, ltsOnly, allRemote);
        if (seq !== remoteSeq.current) return;
        setRemote(data);
        writeRemoteCache(key, data);
        setRemoteCachedAt(null);
        remoteKeyRef.current = key;
        remoteFailedKey.current = null;
        remoteAtRef.current = Date.now();
      } catch (e) {
        if (seq !== remoteSeq.current) return;
        remoteFailedKey.current = key;
        const cached = readRemoteCache(key);
        if (cached) {
          // 离线 / 网络失败时展示上一次成功拉取的列表，并明确标注缓存时间
          setRemote(cached.data);
          setRemoteCachedAt(cached.at);
        } else {
          setRemote(null);
          setRemoteCachedAt(null);
        }
        setRemoteError(errText(e));
      } finally {
        if (seq === remoteSeq.current) {
          setLoadingRemote(false);
          setRemoteStartedAt(null);
        }
      }
    },
    [vpPath, remoteSelector, ltsOnly, allRemote],
  );

  // 只在进入该页 / 选择器 / LTS / --all 变化时自动拉取一次；失败后等用户手动重试
  useEffect(() => {
    if (tab !== "env" || envSection !== "remote" || loadingRemote) return;
    if (remoteKeyRef.current !== remoteKey && remoteFailedKey.current !== remoteKey) {
      void loadRemote(false);
    }
  }, [tab, envSection, remoteKey, loadingRemote, loadRemote]);

  // 窗口重新聚焦时静默刷新（受 TTL 限制，不会每次都拉起子进程）
  useEffect(() => {
    if (!ensureOk) return;
    const refreshIfStale = () => {
      void refresh(false);
      if (tab === "env" && envSection === "remote") void loadRemote(false);
    };
    window.addEventListener("focus", refreshIfStale);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [ensureOk, refresh, loadRemote, tab, envSection]);

  // 安装阶段（下载 / 解压 / 校验）由后端按输出行实时推送
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ phase: string; message: string }>(INSTALL_PHASE_EVENT, (e) => {
      setInstallStage(e.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 只在有长任务 / 远端请求时走秒级时钟，避免空闲时整页重渲染
  useEffect(() => {
    if (!busy && !loadingRemote) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy, loadingRemote]);

  /**
   * 执行一条会改变环境的命令。
   * `refreshRemote` 用于安装 / 卸载后同步刷新远端列表的「已装」标记。
   * 无论成功失败都在 finally 刷新本地状态；失败保留原始输出与重试入口。
   */
  const runOp = useCallback(
    async (
      label: string,
      fn: () => Promise<string>,
      refreshRemote = false,
      summarize?: (out: string) => string,
    ) => {
      setBusy(label);
      setBusySince(Date.now());
      setOpCancelled(false);
      setInstallStage(null);
      setOpError(null);
      setOpResult(null);
      setConsoleText("");
      setConsoleSource(label);
      setConsoleAt(Date.now());
      try {
        const out = await fn();
        setConsoleText(out);
        const detail = summarize ? summarize(out) : "";
        if (summarize) setOpResult({ label, text: detail });
        notify("success", label + " 完成", detail || undefined);
        return true;
      } catch (e) {
        const msg = errText(e);
        setConsoleText(msg);
        setOpError({ label, message: msg, retry: fn });
        notify(
          "error",
          label + " 失败",
          `${msg}\n\n本地状态可能不一致：可点击「重试」，或用「刷新」重新核对；若为安装 / 清理中断，建议检查 \`vp env list\`，必要时执行 \`vp env clean\`。`,
        );
        return false;
      } finally {
        // 无论成功失败都刷新，避免页面停留在旧状态
        await refresh(true);
        // 远端列表没打开过就不额外拉一次网络请求
        if (refreshRemote && (envSection === "remote" || remoteKeyRef.current)) {
          await loadRemote(true);
        }
        setBusy(null);
        setBusySince(null);
        setInstallStage(null);
      }
    },
    [notify, refresh, loadRemote, envSection],
  );

  /** 真取消：后端终止进程树并确认退出，结果如实反馈残留 */
  const cancelOp = useCallback(async () => {
    if (opCancelled) return;
    setOpCancelled(true);
    try {
      const r = await vpCancel();
      if (r.exited) {
        notify("info", "已终止当前命令", r.message);
      } else {
        notify("error", "进程可能仍在运行", r.message);
      }
    } catch (e) {
      notify("error", "取消失败", errText(e));
    }
  }, [opCancelled, notify]);

  const remoteItems: VpRemoteItem[] = useMemo(() => {
    if (!remote) return [];
    if (remoteSelector === "node") return filterNodeRemote(remote.node ?? []);
    return remote.package_managers?.[remoteSelector] ?? [];
  }, [remote, remoteSelector]);

  const groups = useMemo(
    () => groupByMajor(remoteItems, (i) => i.version, perMajor),
    [remoteItems, perMajor],
  );

  const slowRemote =
    loadingRemote && remoteStartedAt !== null && now - remoteStartedAt > REMOTE_SLOW_MS;

  const needDir = (): boolean => {
    if (projectDir && projectDir.trim()) return true;
    notify("error", "请先选择项目目录");
    return false;
  };

  const pickDir = async () => {
    const dir = await pickProjectDir(projectDir);
    if (dir) onProjectDirChange(dir);
  };

  /* ------------------------------------------------------------ 项目 Pin */

  /** 只读读取 pin 来源；失败不清空旧结果，避免误以为项目没有 pin */
  const loadPinReport = useCallback(async () => {
    if (!projectDir || !projectDir.trim()) {
      setPinReport(null);
      return;
    }
    setPinReportBusy(true);
    try {
      setPinReport(await pinInspect(projectDir));
    } catch (e) {
      notify("error", "读取 pin 失败", errText(e));
    } finally {
      setPinReportBusy(false);
    }
  }, [projectDir, notify]);

  useEffect(() => {
    if (tab === "project") void loadPinReport();
  }, [tab, loadPinReport]);

  /** 先做 diff 预览；确认前不写任何文件 */
  const previewPin = async (mode: "pin" | "unpin", specs: string[], target: string | null) => {
    if (!needDir()) return;
    setPinDraftBusy(true);
    try {
      const changes = await pinPreview(projectDir!, specs, target, mode === "unpin");
      setPinDraft({
        mode,
        specs,
        target,
        changes,
        scope: mode === "unpin" ? unpinScope || null : null,
      });
    } catch (e) {
      notify("error", "生成变更预览失败", errText(e));
    } finally {
      setPinDraftBusy(false);
    }
  };

  const executePinDraft = async () => {
    const draft = pinDraft;
    if (!draft || !projectDir) return;
    const changed = draft.changes.filter((c) => c.action !== "unchanged");
    let backupDir: string | null = null;
    if (changed.length) {
      try {
        const backup = await pinBackup(changed.map((c) => c.path));
        backupDir = backup.dir;
        setLastBackupDir(backup.dir);
      } catch (e) {
        // 备份失败时不继续写入：否则无法回滚
        notify("error", "自动备份失败，已取消写入", errText(e));
        return;
      }
    }
    const label =
      draft.mode === "unpin"
        ? `取消固定 ${draft.specs.map((s) => s.split("@")[0]).join(" ")}`
        : `固定 ${draft.specs.join(" ")}`;
    const ok = await runOp(
      label,
      () =>
        draft.mode === "unpin"
          ? vpEnvUnpin(projectDir, draft.scope, vpPath, draft.target)
          : vpEnvPin(projectDir, draft.specs, vpPath, draft.target, pinForce, pinNoInstall),
      false,
      summarizeOp,
    );
    setPinDraft(null);
    if (ok) {
      setPinSpecs("");
      if (backupDir) notify("info", "已自动备份原文件", backupDir);
    }
    void loadPinReport();
  };

  const doPin = async (specs: string[], target: string | null) => {
    await previewPin("pin", specs, target);
  };

  const doPinInput = async () => {
    const specs = pinSpecs.trim().split(/\s+/).filter(Boolean);
    if (!specs.length) {
      notify("error", "请填写要固定的版本", "例如：22.11.0 pnpm@10.18.0");
      return;
    }
    await doPin(specs, pinTarget || null);
  };

  const doUninstall = async (spec: string) => {
    const ok = await confirm(
      `确定卸载 ${spec} 吗？该版本会被删除，依赖它的项目需要重新固定。`,
      "卸载版本",
    );
    if (!ok) return;
    await runOp(`卸载 ${spec}`, () => vpEnvUninstall(spec, vpPath), true);
  };

  const doClean = async () => {
    const ok = await confirm(
      "将删除未被项目使用的托管运行时与包管理器缓存。当前使用中与配置为默认的版本会保留，确定继续吗？",
      "清理未使用的安装",
    );
    if (!ok) return;
    await runOp("清理未使用的安装", () => vpEnvClean(null, vpPath), true);
  };

  const doUnpin = async () => {
    if (!needDir()) return;
    // 预览只需要工具名；版本占位为 0，unpin 时 after 固定展示为“移除”
    const previewSpecs =
      unpinScope === ""
        ? ["node@0", "pnpm@0", "npm@0", "yarn@0", "bun@0"]
        : unpinScope === "pm"
          ? ["pnpm@0", "npm@0", "yarn@0", "bun@0"]
          : [`${unpinScope}@0`];
    await previewPin("unpin", previewSpecs, unpinTarget || null);
  };

  const doUnsetDefault = async () => {
    const ok = await confirm("将清除系统默认版本设置，之后由 Vite+ 自行解析。", "清除系统默认版本");
    if (!ok) return;
    await runOp("清除系统默认版本", () => vpEnvDefault(null, true, vpPath));
  };

  const doInstall = async (spec: string): Promise<boolean> => {
    setLastInstallSpec(spec);
    const ok = await runOp(`安装 ${spec}`, () => vpEnvInstall(spec, vpPath), true, summarizeOp);
    if (ok) setLastInstallSpec(null);
    if (!ok || !isNodeSpec(spec)) return ok;
    // Vite+ 托管模式下，命令行 node 未设系统默认时会在线解析并自动下载，
    // 这里在安装 Node 后检测并引导用户设默认，保证 node -v 直接可用
    try {
      const list = await vpEnvList(vpPath);
      if ((list.node ?? []).some((i) => i.default)) return true;
      const v = spec.startsWith("node@") ? spec.slice("node@".length) : spec;
      const yes = await confirm(
        `当前尚未设置系统默认 Node 版本。\n` +
          `命令行中的 node 已由 Vite+ 托管，未设默认时执行 node -v 会在线解析并自动下载最新稳定版。\n\n` +
          `是否将 ${v} 设为系统默认（vp env default）？所有未固定的目录都会使用它。`,
        "设置系统默认 Node 版本",
      );
      if (yes) {
        await runOp(`设为系统默认 ${v}`, () => vpEnvDefault(v, false, vpPath), true);
      }
    } catch {
      /* 默认版本检测失败不影响安装结果 */
    }
    return true;
  };

  /** 安装失败后的一键恢复：先清理未完成安装，再重试同一 spec */
  const cleanAndRetryInstall = async (spec: string) => {
    setOpError(null);
    const ok = await runOp("清理残留安装", () => vpEnvClean(null, vpPath));
    if (!ok) return;
    await doInstall(spec);
  };

  /** 按项目里已有的 pin / packageManager 一次性装齐环境 */
  const doInstallProjectEnv = async () => {
    if (!needDir()) return;
    const ok = await confirm(
      `将按项目的固定配置安装完整的 Node.js 与包管理器环境：\n${projectDir}`,
      "安装项目环境",
    );
    if (!ok) return;
    await runOp("安装项目环境", () => vpEnvInstall(null, vpPath, projectDir), true, summarizeOp);
  };

  /** `vp install`：安装项目 package.json 里声明的依赖，不改 Node / 包管理器版本 */
  const doInstallProjectDeps = async () => {
    if (!needDir()) return;
    const ok = await confirm(
      `将在此项目目录执行 vp install（安装 package.json 依赖）：\n${projectDir}\n\n` +
        `这不会安装 Node.js / 包管理器；需要它们时请用「安装项目环境」。`,
      "安装项目依赖",
    );
    if (!ok) return;
    await runOp("安装项目依赖", () => vpInstallProject(projectDir!, vpPath));
  };

  /** 检查 Vite+ 自身是否有新版本（只读，不改环境） */
  const doUpgradeCheck = async () => {
    await runOp("检查 Vite+ 更新", async () => {
      const r = await vpUpgradeCheck(vpPath);
      setUpgradeCheck(r);
      return r.raw;
    });
  };

  /** 升级 Vite+ 自身：会替换全局 CLI，完成后必须重新自检 */
  const doUpgradeVp = async () => {
    const current = upgradeCheck?.current ?? ensure?.version ?? null;
    const latest = upgradeCheck?.latest ?? null;
    if (upgradeCheck?.up_to_date) {
      notify("info", "Vite+ 已是最新", latest ? `当前 v${latest}` : undefined);
      return;
    }
    const ok = await confirm(
      `将执行 vp upgrade，把全局 Vite+ 从 ${current ? `v${current}` : "当前版本"} 升级到${
        latest ? ` v${latest}` : "最新版本"
      }。\n\n这会替换 vp 可执行文件；升级完成后需要新开终端或重启应用。`,
      "升级 Vite+",
    );
    if (!ok) return;
    const done = await runOp("升级 Vite+", () => vpUpgrade(vpPath));
    if (done) {
      setUpgradeCheck(null);
      notify("info", "Vite+ 升级完成", "请新开终端或重启应用，让新的 vp 生效。");
      onRecheck();
    } else {
      // 失败后刷新检查结果，避免继续显示旧结论
      try {
        setUpgradeCheck(await vpUpgradeCheck(vpPath));
      } catch {
        setUpgradeCheck(null);
      }
    }
  };

  /** 刷新 shim，并在前后各做一次 PATH 审计，展示「新增 / 仍缺失」 */
  const doRefreshShims = async () => {
    const before = pathAudit?.tools ?? [];
    const done = await runOp("刷新 shims", async () => {
      const out = await vpEnvSetup(true, false, vpPath);
      let after: PathAudit | null = null;
      try {
        after = await envPathAudit(vpPath);
        setPathAudit(after);
      } catch {
        after = null;
      }
      if (!after) return `${out}\n\n审计失败，请稍后手动刷新页面查看 shim 状态。`;
      const changes: string[] = [];
      for (const t of after.tools) {
        const prev = before.find((b) => b.tool === t.tool);
        if (prev && prev.shim_exists !== t.shim_exists) {
          changes.push(
            `${t.tool}: ${prev.shim_exists ? "已有 shim" : "缺失"} → ${t.shim_exists ? "已生成" : "仍缺失"}`,
          );
        }
      }
      const missing = after.tools.filter((t) => !t.shim_exists).map((t) => t.tool);
      const state = missing.length ? `仍缺失：${missing.join("、")}` : "全部主工具 shim 已生成";
      return `${out}\n\nshim 变化${changes.length ? `：\n${changes.join("\n")}` : "：无"}\n${state}\n需新开终端（或重启应用）让 PATH 生效。`;
    });
    if (done) void refresh(true);
  };

  /** 跟随 dist-tag 的默认版本：后续每次解析都会重新取标签指向的版本 */
  const doSetTagDefault = async () => {
    const spec = tagDefault.trim();
    if (!spec) {
      notify("error", "请填写要跟随的标签", "例如 lts、latest、pnpm@latest-10");
      return;
    }
    const ok = await confirm(
      `将把 ${spec} 设为全局默认。\n` +
        `跟随标签的默认值会在每次使用时重新解析（缓存 1 小时），新的大版本也会自动生效。\n` +
        `Node 使用 lts / latest；包管理器使用 latest / latest-<大版本>。`,
      "设置跟随标签的默认版本",
    );
    if (!ok) return;
    const done = await runOp(
      `设置默认 ${spec}`,
      () => vpEnvDefault(spec, false, vpPath),
      true,
      summarizeOp,
    );
    if (done) setTagDefault("");
  };

  const doMode = async (managed: boolean) => {
    const ok = await confirm(
      `将全局切换到${managed ? " Vite+ 托管模式" : "系统优先模式"}。\n\n这会修改 shell 配置，影响之后新开的终端。确定继续吗？`,
      "切换托管模式",
    );
    if (!ok) return;
    await runOp(managed ? "切换到托管模式" : "切换到系统优先", async () => {
      const before = modeInfo(current?.node?.mode ?? current?.package_manager?.mode).label;
      const out = await vpEnvMode(managed, null, vpPath);
      try {
        const next = await vpEnvCurrent(vpPath, projectDir);
        setCurrent(next);
        const after = modeInfo(next?.node?.mode ?? next?.package_manager?.mode).label;
        return `${out}\n\n托管模式：${before} → ${after}\n需新开终端（或重启应用）后生效。`;
      } catch {
        return `${out}\n\n需新开终端（或重启应用）后生效。`;
      }
    });
  };

  /* ------------------------------------------------------------ 渲染片段 */

  const renderInstalledRow = (selector: string, item: VpInstalledItem) => {
    const v = displayVersion(item.version);
    return (
      <div className="list-row" key={`${selector}-${v}`}>
        <span className="v">{v}</span>
        {item.current ? <span className="tag accent">当前</span> : null}
        {item.default ? <span className="tag ok">系统默认</span> : null}
        <div className="row-actions">
          <button
            className="btn sm"
            disabled={!!busy || item.default}
            title="vp env default：写入全局默认，所有未固定的目录都会解析到这个版本"
            onClick={() =>
              void runOp(`设为系统默认 ${selector}@${v}`, () =>
                vpEnvDefault(specFor(selector, v, false), false, vpPath),
              )
            }
          >
            设为系统默认
          </button>
          <button
            className="btn sm danger"
            disabled={!!busy}
            onClick={() => void doUninstall(specFor(selector, v, true))}
          >
            卸载
          </button>
        </div>
      </div>
    );
  };

  /* ------------------------------------------------------------ 启动自检状态 */

  const head = (
    <div className="page-head">
      <div className="page-title-row">
        <span className="page-icon">
          <Icon name="bolt" size={18} />
        </span>
        <div>
          <h2 className="page-title">Vite+ 环境管理</h2>
          <p className="page-desc">
            {resolved ? (
              <>
                {version} ·{" "}
                <code className="path-text" title={resolved}>
                  {resolved}
                </code>
              </>
            ) : (
              "正在准备 Vite+ 环境…"
            )}
          </p>
        </div>
      </div>
      <div className="page-actions">
        <span className={`status-pill ${ensureOk ? "ok" : ensureBusy ? "busy" : "warn"}`}>
          <span className="status-dot" />
          {ensureBusy ? "检测中" : ensureOk ? "环境就绪" : "需要处理"}
        </span>
        <button
          className="btn ghost sm"
          onClick={onRecheck}
          title="重新检查 Vite+ 版本是否满足 ≥ 1.4.0"
        >
          <Icon name="refresh" size={13} />
          重新检测
        </button>
      </div>
    </div>
  );

  if (ensureBusy || !ensure) {
    const title = ensure?.upgraded
      ? "正在升级 Vite+"
      : ensure?.installed
        ? "正在安装 Vite+"
        : "正在检查 Vite+ 环境";
    return (
      <div className="env-view">
        {head}
        <div className="env-health busy">
          <span className="spinner dark" />
          <div className="env-health-body">
            <div className="env-health-title">{title}</div>
            <div className="env-health-desc">
              {ensurePhase?.message ??
                (ensureBusy
                  ? "正在检测是否已安装、版本是否满足 ≥ 1.5.0；安装或升级可能需要几分钟。"
                  : "正在启动环境自检…")}
            </div>
          </div>
          {!ensureBusy ? (
            <button className="btn sm" onClick={onRecheck}>
              重新检测
            </button>
          ) : null}
        </div>
        <div className="hint">
          启动时只检测 Vite+ 与环境版本，不会自动安装或升级。需要改动时请点击上方的
          <b>自动安装 / 升级</b> 按钮；安装完成后请新开终端或重启应用，让新的 PATH 生效。
        </div>
      </div>
    );
  }

  if (!ensureOk) {
    return (
      <div className="env-view">
        {head}
        <OperationFeedback
          tone="warn"
          title="需要安装或升级 Vite+"
          detail={`${ensure.error ?? "启动自检未通过。"}${
            ensure.version ? `\n当前 v${ensure.version}，要求 ≥ 1.4.0` : ""
          }${ensure.log ? `\n\n${ensure.log}` : ""}`}
          note="也可以按下面的命令手动安装，然后回到这里重新检测。"
          actions={
            <button className="btn primary sm" onClick={onRepair} disabled={ensureBusy}>
              自动安装 / 升级
            </button>
          }
        />

        <div className="card" style={{ padding: 16 }}>
          <h4 className="section-title">手动安装 / 升级</h4>
          <div className="vp-install-cmd">
            <span className="vp-install-label">Windows PowerShell</span>
            <code>irm https://vite.plus/ps1 | iex</code>
          </div>
          <div className="vp-install-cmd">
            <span className="vp-install-label">macOS / Linux</span>
            <code>curl -fsSL https://vite.plus | bash</code>
          </div>
          <div className="vp-install-cmd">
            <span className="vp-install-label">已安装但版本过低</span>
            <code>vp upgrade</code>
          </div>
          <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
            <button className="btn" onClick={() => void openUrl("https://viteplus.dev/guide/")}>
              打开安装指南
            </button>
            <button className="btn" onClick={onRecheck} disabled={ensureBusy}>
              已完成，重新检测
            </button>
          </div>
          <p className="hint">
            已经安装过？可能是位置未被识别，可到「设置」中手动指定 vp 路径。
            若手动指定了路径但不可用，自动安装不会覆盖该配置。
          </p>
        </div>
      </div>
    );
  }

  const mode = modeInfo(current?.node?.mode ?? current?.package_manager?.mode);
  const shim = shimInfo(pathAudit, mode);
  const nodeAudit = pathAudit?.tools.find((t) => t.tool === "node");
  const nodeInstalled = current?.node?.installed;

  /* ------------------------------------------------------------ 结构化诊断 */

  const runDoctorReport = async () => {
    if (!needDir()) return;
    await runOp("环境诊断（结构化）", async () => {
      const r = await vpDoctorReport(vpPath, projectDir, null);
      setDoctorReport(r);
      setWhichReport(null);
      setPrintRaw("");
      return r.raw;
    });
  };

  /** which 与 print 合并为一个查询入口：一次并行取回路径来源与 PATH 设置 */
  const runWhichAndPrint = async () => {
    await runOp(`查询 ${whichTool} 路径与 PATH`, async () => {
      const [r, out] = await Promise.all([
        vpWhichReport(whichTool, vpPath, projectDir),
        vpEnvPrint(null, vpPath, projectDir),
      ]);
      setWhichReport(r);
      setPrintRaw(out);
      setDoctorReport(null);
      return `${r.raw}\n\n${out}`;
    });
  };

  /** 可复制的诊断摘要，方便报障时贴给维护者 */
  const copyDiagnostics = async () => {
    const lines: string[] = [
      `FlowDeck ${APP_VERSION}`,
      `vp 路径：${ensure?.path ?? "—"}`,
      `vp 版本：${ensure?.version ?? "—"}`,
      `平台：${navigator.platform || navigator.userAgent}`,
      `项目目录：${projectDir || "（未选择）"}`,
      `当前 Node：${current?.node?.version ?? "—"}（来源：${current?.node?.source ?? "—"}）`,
      `托管模式：${mode.label}`,
      `shim 目录：${pathAudit?.shim_dir ?? "—"}`,
      `shim 生效：${shim.label}`,
      `PATH 首命中 node：${nodeAudit?.hits[0] ?? "未命中"}`,
      `node 副本数：${nodeAudit ? nodeAudit.hits.length : "—"}`,
      `PATH / shim 警告：${pathAudit?.warnings.length ? pathAudit.warnings.join("；") : "无"}`,
    ];
    if (pinReport) {
      const pins = pinReport.entries
        .filter((e) => e.effective)
        .map((e) => `${e.key}=${e.raw} (${e.file} @ ${e.dir})`);
      lines.push(`pin 命中：${pins.length ? pins.join("; ") : "无"}`);
      if (pinReport.conflicts.length) {
        lines.push(
          `pin 冲突：${pinReport.conflicts
            .map((c) => `${c.key}=${c.values.join("/")} @ ${c.dir}`)
            .join("; ")}`,
        );
      }
    }
    if (ensure?.warnings?.length) lines.push(`自检警告：${ensure.warnings.join(" | ")}`);
    if (doctorReport) lines.push("", "vp env doctor:", doctorReport.raw);
    if (whichReport) lines.push("", `vp env which ${whichReport.tool}:`, whichReport.raw);
    if (printRaw) lines.push("", "vp env print:", printRaw);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify("success", "诊断摘要已复制", "可直接粘贴到反馈里");
    } catch (e) {
      notify("error", "复制失败", errText(e));
    }
  };

  /** 概览告警：每条都必须带可执行动作，否则不放概览 */
  const alerts: {
    key: string;
    tone: "danger" | "warn" | "info";
    title: string;
    desc: string;
    action?: React.ReactNode;
  }[] = [];
  const copyFix = async () => {
    try {
      await navigator.clipboard.writeText("vp env setup --refresh");
      notify("success", "已复制修复命令", "vp env setup --refresh");
    } catch (e) {
      notify("error", "复制失败", errText(e));
    }
  };
  if (loadError) {
    alerts.push({
      key: "load-error",
      tone: "danger",
      title: "环境数据读取失败",
      desc: loadError,
      action: (
        <>
          <button className="btn sm" onClick={() => void refresh(true)} disabled={!!busy}>
            重试读取
          </button>
          <button className="btn sm ghost" onClick={onRecheck}>
            检查 vp 路径
          </button>
        </>
      ),
    });
  }
  const ensureWarnings = ensure.warnings ?? [];
  if (ensureWarnings.length) {
    const key = "ensure-warnings";
    alerts.push({
      key,
      tone: "warn",
      title: "Vite+ 环境提示",
      desc: ensureWarnings.join("\n"),
      action: (
        <>
          <button className="btn sm" onClick={() => goTab("env")}>
            去环境处理
          </button>
          <button className="btn sm ghost" onClick={() => void copyFix()}>
            复制修复命令
          </button>
          <button className="btn sm ghost" onClick={() => setDismissedAlerts((p) => [...p, key])}>
            忽略
          </button>
        </>
      ),
    });
  }
  if (pathAudit?.warnings.length) {
    const key = "path-audit";
    alerts.push({
      key,
      tone: shim.tone === "danger" ? "danger" : "warn",
      title: `PATH / shim 审计发现 ${pathAudit.warnings.length} 项`,
      desc: pathAudit.warnings.join("；"),
      action: (
        <>
          <button className="btn sm" onClick={() => goTab("env")}>
            去环境处理
          </button>
          <button className="btn sm ghost" onClick={() => void copyFix()}>
            复制 setup 命令
          </button>
          <button className="btn sm ghost" onClick={() => setDismissedAlerts((p) => [...p, key])}>
            忽略
          </button>
        </>
      ),
    });
  }
  if (nodeInstalled === false) {
    const key = "node-missing";
    alerts.push({
      key,
      tone: "info",
      title: "当前目录没有解析到已安装的 Node",
      desc: "首次执行 node -v 可能触发在线下载；建议先在环境页安装版本或设置全局默认。",
      action: (
        <button className="btn sm" onClick={() => goTab("env")}>
          去环境安装
        </button>
      ),
    });
  }
  const visibleAlerts = alerts.filter((a) => !dismissedAlerts.includes(a.key));
  const defaultNodeVersion = installed?.node?.find((n) => n.default)?.version ?? null;
  /** 全局默认包管理器：直接取 vp env list 的 default 标记，不依赖项目解析结果 */
  const defaultPms = ["bun", "pnpm", "npm", "yarn"].flatMap((id) => {
    const item = installed?.package_managers?.[id]?.find((p) => p.default);
    return item ? [`${id} ${displayVersion(item.version)}`] : [];
  });
  const defaultPm = defaultPms.length ? defaultPms.join(" · ") : null;
  /** 只有 vp 明确返回 source=default 时才展示全局配置文件路径，避免路径猜测 */
  const globalPinSource =
    current?.node?.source === "default" ? current.node.source_path : undefined;

  const remoteEmpty = !loadingRemote && !remoteError && groups.length === 0;

  /* 概览用到的轻量统计（只读展示，不改变任何操作语义） */
  const installedNodeCount = installed?.node?.length ?? 0;
  const installedPmCount = ["pnpm", "npm", "yarn", "bun"].reduce(
    (n, id) => n + (installed?.package_managers?.[id]?.length ?? 0),
    0,
  );
  const vpCopies = pathAudit?.vp_candidates ?? [];
  const globalCopies = vpCopies.filter((c) => c.scope === "global").length;
  const projectCopies = vpCopies.filter((c) => c.scope === "project").length;
  const unknownCopies = vpCopies.filter((c) => c.scope === "unknown").length;
  const effectivePins = pinReport?.entries?.filter((e) => e.effective).length ?? 0;

  const failureInfo = opError ? classifyFailure(opError.message) : null;

  return (
    <div className="env-view">
      {busy ? (
        <OperationProgress
          label={busy}
          startedAt={busySince}
          cancelled={opCancelled}
          stage={installStage}
          onCancel={() => void cancelOp()}
        />
      ) : null}

      {opError && !busy ? (
        <OperationFeedback
          tone="error"
          title={`操作失败：${opError.label}`}
          detail={opError.message}
          note={`失败分类：${failureInfo?.label ?? "未知失败"}。${
            failureInfo?.tip ?? ""
          } 本地状态可能不一致：可点击「重试」，或用「刷新」重新核对；若为安装 / 清理中断，建议检查 vp env list，必要时执行 vp env clean。`}
          actions={
            <>
              <button
                className="btn sm"
                onClick={() => {
                  const failed = opError;
                  setOpError(null);
                  void runOp(failed.label, failed.retry);
                }}
              >
                重试
              </button>
              {lastInstallSpec ? (
                <button
                  className="btn sm"
                  onClick={() => void cleanAndRetryInstall(lastInstallSpec)}
                >
                  清理残留并重试
                </button>
              ) : null}
            </>
          }
          onClose={() => setOpError(null)}
        />
      ) : null}

      {opResult && !busy ? (
        <OperationFeedback
          tone="success"
          title={`已完成：${opResult.label}`}
          detail={opResult.text || "命令执行成功（无输出）"}
          onClose={() => setOpResult(null)}
        />
      ) : null}

      <div
        className="env-tabs"
        role="tablist"
        aria-label="环境管理标签页"
        hidden={!!onTabChange}
        style={onTabChange ? { display: "none" } : undefined}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`env-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => goTab(t.id)}
            role="tab"
            aria-selected={tab === t.id}
          >
            <Icon name={t.icon} size={13} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="overview-body">
          {!hasData && !loadError ? (
            <SkeletonCards rows={4} />
          ) : (
            <>
              <section className="status-band" aria-label="关键状态">
                <div className="band-cell">
                  <span className="band-label">Vite+ CLI</span>
                  <span className="band-value">{version ? `v${version}` : "未就绪"}</span>
                  <code className="band-sub ellipsis" title={resolved ?? undefined}>
                    {resolved ?? "未定位到 vp"}
                  </code>
                </div>
                <div className="band-cell">
                  <span className="band-label">托管模式 / Shim</span>
                  <span className="band-value">{shim.label}</span>
                  <span className="band-sub ellipsis">{shim.sub}</span>
                </div>
                <div className="band-cell">
                  <span className="band-label">全局默认</span>
                  <span className="band-value">
                    {defaultNodeVersion ? displayVersion(defaultNodeVersion) : "未设默认"}
                  </span>
                  <span className="band-sub ellipsis">
                    {defaultPm ? `包管理器 ${defaultPm}` : "包管理器未设默认"}
                  </span>
                </div>
                <div className="band-actions">
                  <span className={`status-pill ${ensureOk ? "ok" : ensureBusy ? "busy" : "warn"}`}>
                    <span className="status-dot" />
                    {ensureBusy ? "检测中" : ensureOk ? "环境就绪" : "需要处理"}
                  </span>
                  <button
                    className="btn ghost sm"
                    onClick={onRecheck}
                    title="重新检测 Vite+ 与环境状态"
                  >
                    <Icon name="refresh" size={12} />
                    重新检测
                  </button>
                </div>
              </section>

              <div className="status-cards overview-cards">
                <StatusCard
                  label="全局 Pin"
                  tone={defaultNodeVersion ? "ok" : "neutral"}
                  icon="pin"
                  value={defaultNodeVersion ? displayVersion(defaultNodeVersion) : "未设全局默认"}
                  sub={defaultPm ? `默认包管理器 ${defaultPm}` : "未设默认包管理器"}
                  hint={globalPinSource ?? undefined}
                  actions={
                    <button className="btn ghost sm" onClick={() => goTab("env")}>
                      管理
                      <Icon name="arrow-right" size={12} />
                    </button>
                  }
                />
                <StatusCard
                  label="当前 Node"
                  tone={
                    nodeInstalled === false ? "warn" : current?.node?.version ? "ok" : "neutral"
                  }
                  icon="package"
                  value={current?.node?.version ? displayVersion(current.node.version) : "—"}
                  sub={`来源：${current?.node?.source ?? "—"}`}
                  hint={current?.node?.bin_path ?? undefined}
                />
                <StatusCard
                  label="包管理器"
                  tone={current?.package_manager?.version ? "ok" : "neutral"}
                  icon="sliders"
                  value={
                    current?.package_manager
                      ? `${current.package_manager.name ?? "—"} ${
                          current.package_manager.version ?? ""
                        }`.trim()
                      : "—"
                  }
                  sub="当前解析结果"
                />
                <StatusCard
                  label="已安装运行时"
                  tone={installedNodeCount ? "ok" : "neutral"}
                  icon="layers"
                  value={`${installedNodeCount} 个 Node`}
                  sub={`${installedPmCount} 个包管理器版本`}
                  actions={
                    <button className="btn ghost sm" onClick={() => goTab("env")}>
                      管理
                      <Icon name="arrow-right" size={12} />
                    </button>
                  }
                />
                <StatusCard
                  label="vp 副本"
                  tone={globalCopies > 1 ? "warn" : "neutral"}
                  icon="layers-stack"
                  value={`${vpCopies.length} 个`}
                  sub={`全局 ${globalCopies} · 项目内 ${projectCopies} · 未知 ${unknownCopies}`}
                  actions={
                    <button className="btn ghost sm" onClick={() => goTab("diagnostics")}>
                      诊断
                      <Icon name="arrow-right" size={12} />
                    </button>
                  }
                />
              </div>
            </>
          )}

          <div className="overview-bottom">
            {visibleAlerts.length ? (
              <div className="alert-list">
                {visibleAlerts.map((a) => (
                  <div className={`alert-panel tone-${a.tone}`} key={a.key} role="status">
                    <span className="alert-icon" aria-hidden="true">
                      <Icon name={TONE_ICON[a.tone]} size={15} />
                    </span>
                    <div className="alert-body">
                      <div className="alert-title">{a.title}</div>
                      <div className="alert-desc alert-desc-lines">{a.desc}</div>
                    </div>
                    {a.action ? <div className="alert-actions">{a.action}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <section className="check-panel" aria-label="环境检查摘要">
                <div className="check-head">
                  <span className="check-badge" aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                  <b>未发现需要处理的告警</b>
                  <span className="muted small">PATH 顺序、shim 与全局默认均正常</span>
                </div>
                <div className="check-grid">
                  <div className="check-item">
                    <span>PATH 首命中 node</span>
                    <code className="path-text" title={nodeAudit?.hits[0] ?? undefined}>
                      {nodeAudit?.hits[0] ?? "未命中"}
                    </code>
                  </div>
                  <div className="check-item">
                    <span>Shim 目录</span>
                    <code className="path-text" title={pathAudit?.shim_dir ?? undefined}>
                      {pathAudit?.shim_dir ?? "审计中…"}
                    </code>
                  </div>
                  <div className="check-item">
                    <span>托管模式</span>
                    <span className="check-value">{mode.label}</span>
                  </div>
                  <div className="check-item">
                    <span>最近检查</span>
                    <span className="check-value">
                      {lastLoadedAt ? clock(lastLoadedAt) : "—"}
                      <span className="muted small"> · vp {version || "—"}</span>
                    </span>
                  </div>
                  <div className="check-item">
                    <span>全局默认</span>
                    <span className="check-value">
                      {defaultNodeVersion ? displayVersion(defaultNodeVersion) : "未设置"}
                      {defaultPm ? ` · ${defaultPm}` : ""}
                    </span>
                  </div>
                  <div className="check-item">
                    <span>PATH 警告</span>
                    <span className="check-value">
                      {pathAudit?.warnings.length ? `${pathAudit.warnings.length} 条` : "无"}
                    </span>
                  </div>
                </div>
              </section>
            )}
          </div>

          <div className="update-strip">
            <span className="update-version">Vite+ {version || "未就绪"}</span>
            <span className="update-state">
              {upgradeCheck
                ? upgradeCheck.up_to_date
                  ? "已是最新"
                  : `可升级到 v${upgradeCheck.latest ?? "?"}`
                : "尚未检查更新"}
            </span>
            <span className="update-time">检查于 {clock(lastLoadedAt)}</span>
            <div className="spacer" />
            <button
              className="btn sm ghost"
              disabled={ensureBusy}
              onClick={onRecheck}
              title="重新检测 Vite+ 与环境状态"
            >
              <Icon name="refresh" size={12} />
              重新检测
            </button>
            <button
              className="btn sm"
              disabled={!!busy || !ensureOk}
              onClick={() => void doUpgradeCheck()}
              title="只读执行 vp upgrade --check"
            >
              <Icon name="search" size={12} />
              检查更新
            </button>
            {upgradeCheck && !upgradeCheck.up_to_date ? (
              <button
                className="btn sm primary"
                disabled={!!busy}
                onClick={() => void doUpgradeVp()}
              >
                <Icon name="download" size={12} />
                升级
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "env" ? (
        <>
          {loadError ? (
            <div className="alert-panel tone-danger" role="alert">
              <span className="alert-icon" aria-hidden="true">
                <Icon name="alert" size={15} />
              </span>
              <div className="alert-body">
                <div className="alert-title">环境数据读取失败</div>
                <div className="alert-desc">{loadError}</div>
              </div>
              <div className="alert-actions">
                <button className="btn sm" onClick={() => void refresh(true)} disabled={!!busy}>
                  重试读取
                </button>
              </div>
            </div>
          ) : null}

          <div className="page-split">
            <div className="split-col split-main">
              <div className="segmented" role="tablist" aria-label="环境视图">
                <button
                  role="tab"
                  aria-selected={envSection === "installed"}
                  className={envSection === "installed" ? "active" : ""}
                  onClick={() => setEnvSection("installed")}
                >
                  已安装
                </button>
                <button
                  role="tab"
                  aria-selected={envSection === "remote"}
                  className={envSection === "remote" ? "active" : ""}
                  onClick={() => setEnvSection("remote")}
                >
                  可安装版本
                </button>
              </div>

              {envSection === "installed" ? (
                <div className="list-scroll">
                  {!installed && !loadError ? (
                    <SkeletonRows rows={6} />
                  ) : (
                    SELECTORS.map((s) => {
                      const items = s.isNode
                        ? (installed?.node ?? [])
                        : (installed?.package_managers?.[s.id] ?? []);
                      return (
                        <div className="major-group" key={s.id}>
                          <div className="major-head">
                            <span className="major-title">{s.label}</span>
                            <span className="major-bar" />
                            <span className="major-count">{items.length} 个</span>
                          </div>
                          <div className="list">
                            {items.length ? (
                              items.map((i) => renderInstalledRow(s.id, i))
                            ) : (
                              <div className="list-row">
                                <span className="muted small">暂无安装</span>
                                <div className="row-actions">
                                  <button
                                    className="btn ghost sm"
                                    onClick={() => setEnvSection("remote")}
                                  >
                                    去安装
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : (
                <>
                  <div className="toolbar compact">
                    <select
                      className="select"
                      style={{ width: 116 }}
                      value={remoteSelector}
                      onChange={(e) => {
                        setRemoteSelector(e.target.value);
                        resetRemote();
                        // `--lts` 只对 Node.js 有效，切到包管理器时必须复位，否则请求必然失败
                        if (e.target.value !== "node") setLtsOnly(false);
                      }}
                    >
                      {SELECTORS.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <label
                      className="row"
                      style={{ gap: 5, fontSize: 12.5 }}
                      title={
                        remoteSelector === "node"
                          ? "只列出 Node.js LTS 版本"
                          : "仅 Node.js 支持 --lts（包管理器没有 LTS 概念）"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={ltsOnly}
                        disabled={remoteSelector !== "node"}
                        onChange={(e) => {
                          setLtsOnly(e.target.checked);
                          resetRemote();
                        }}
                      />
                      仅 LTS
                    </label>
                    {/* Node.js 已按「18+ LTS 与最新线」筛选，--all 只会多拉回更旧的版本，没有意义 */}
                    {remoteSelector !== "node" ? (
                      <label
                        className="row"
                        style={{ gap: 5, fontSize: 12.5 }}
                        title="默认只返回近期版本；勾选后列出全部历史版本（--all）"
                      >
                        <input
                          type="checkbox"
                          checked={allRemote}
                          onChange={(e) => {
                            setAllRemote(e.target.checked);
                            resetRemote();
                          }}
                        />
                        含全部
                      </label>
                    ) : null}
                    <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
                      每大版本
                      <select
                        className="select"
                        style={{ width: 58 }}
                        value={perMajor}
                        onChange={(e) => setPerMajor(Number(e.target.value))}
                      >
                        {[1, 2, 3, 5, 10].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      个
                    </label>
                    <button
                      className="btn sm"
                      disabled={loadingRemote}
                      onClick={() => {
                        resetRemote();
                        void loadRemote(true);
                      }}
                    >
                      <Icon name="refresh" size={13} />
                      {loadingRemote ? "获取中…" : "重新获取"}
                    </button>
                    <span className="hint" style={{ margin: 0 }}>
                      {remoteSelector === "node"
                        ? `共 ${remoteItems.length} 个（LTS + latest）`
                        : `共 ${remoteItems.length} 个`}
                    </span>
                    {remoteCachedAt ? (
                      <span
                        className="tag plain"
                        title="网络请求失败，正在展示上一次成功获取的列表"
                      >
                        缓存于 {clock(remoteCachedAt)}
                      </span>
                    ) : null}
                  </div>

                  <div className="install-bar">
                    <Icon name="download" size={15} />
                    <input
                      className="input mono"
                      placeholder="版本或 dist-tag，例如 22、lts、pnpm@latest-10"
                      value={installSpec}
                      onChange={(e) => setInstallSpec(e.target.value)}
                      style={{ flex: "1 1 220px" }}
                    />
                    <button
                      className="btn primary"
                      disabled={!!busy || !installSpec.trim()}
                      onClick={() => {
                        const spec = installSpec.trim();
                        void doInstall(spec).then((ok) => {
                          if (ok) setInstallSpec("");
                        });
                      }}
                    >
                      安装
                    </button>
                  </div>

                  <div className="list-scroll">
                    {loadingRemote ? (
                      <>
                        <div className="busy-banner">
                          <span className="spinner dark" />
                          正在从远端拉取版本列表…（已耗时{" "}
                          {((now - (remoteStartedAt ?? now)) / 1000) | 0}
                          s）
                        </div>
                        {slowRemote ? (
                          <div className="alert-panel tone-warn">
                            <span className="alert-icon" aria-hidden="true">
                              <Icon name="clock" size={15} />
                            </span>
                            <div className="alert-body">
                              <div className="alert-title">远端响应较慢</div>
                              <div className="alert-desc">
                                仍在请求中，后端会在 60s
                                后超时。可以继续等待，或稍后点「重新获取」。
                              </div>
                            </div>
                          </div>
                        ) : null}
                        <SkeletonRows rows={5} />
                      </>
                    ) : null}

                    {remoteError && !loadingRemote ? (
                      <OperationFeedback
                        tone="error"
                        title="获取可安装版本失败"
                        detail={remoteError}
                        actions={
                          <button
                            className="btn sm"
                            onClick={() => {
                              resetRemote();
                              void loadRemote(true);
                            }}
                          >
                            重新获取
                          </button>
                        }
                        onClose={() => setRemoteError(null)}
                      />
                    ) : null}

                    {groups.slice(0, showAllMajor ? groups.length : 6).map((g) => (
                      <div className="major-group" key={g.major}>
                        <div className="major-head">
                          <span className="major-title">
                            {remoteSelector === "node" ? `Node.js ${g.major}.x` : `v${g.major}.x`}
                          </span>
                          <span className="major-bar" />
                          <span className="major-count">最新 {g.items.length} 个</span>
                        </div>
                        <div className="chips">
                          {g.items.map((item) => {
                            const spec = specFor(remoteSelector, item.version, true);
                            return (
                              <button
                                key={item.version}
                                className={`chip ${item.current ? "current" : ""} ${
                                  item.installed ? "installed" : ""
                                }`}
                                disabled={!!busy}
                                title={
                                  item.installed
                                    ? `已安装 · 点击重新安装或修复 ${spec}`
                                    : `安装 ${spec}`
                                }
                                onClick={() => void doInstall(spec)}
                              >
                                {displayVersion(item.version)}
                                {item.lts ? <span className="tag plain">{item.lts}</span> : null}
                                {item.latest && item.latest_lts ? (
                                  <span className="tag accent">latest LTS</span>
                                ) : item.latest ? (
                                  <span className="tag accent">latest</span>
                                ) : item.latest_lts ? (
                                  <span className="tag ok">最新 LTS</span>
                                ) : null}
                                {item.installed ? <span className="tag ok">已装</span> : null}
                                {item.default ? <span className="tag plain">系统默认</span> : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {groups.length > 6 && !showAllMajor ? (
                      <button
                        className="btn sm ghost"
                        style={{ alignSelf: "flex-start" }}
                        onClick={() => setShowAllMajor(true)}
                      >
                        显示其余 {groups.length - 6} 个大版本
                      </button>
                    ) : null}

                    {remoteEmpty ? (
                      <EmptyState
                        icon="download"
                        title="没有可展示的版本"
                        desc="可能是筛选条件过窄，或远端列表为空。"
                        actions={
                          <button
                            className="btn sm"
                            onClick={() => {
                              resetRemote();
                              void loadRemote(true);
                            }}
                          >
                            重新获取
                          </button>
                        }
                      />
                    ) : null}
                  </div>
                </>
              )}

              <div className="list-foot">
                <span>
                  已安装 {installedNodeCount} 个 Node · {installedPmCount} 个包管理器
                </span>
                <span className="muted small">
                  默认 Node {defaultNodeVersion ? displayVersion(defaultNodeVersion) : "未设置"}
                </span>
              </div>
            </div>

            <aside className="split-col split-side">
              <section className="panel">
                <div className="panel-head">当前生效</div>
                <div className="detail-row">
                  <span>Node</span>
                  <b>{current?.node?.version ? displayVersion(current.node.version) : "—"}</b>
                </div>
                <div className="detail-row">
                  <span>来源</span>
                  <span className="ellipsis">{current?.node?.source ?? "—"}</span>
                </div>
                <div className="detail-row">
                  <span>可执行</span>
                  <code className="path-text" title={current?.node?.bin_path ?? undefined}>
                    {current?.node?.bin_path ?? "—"}
                  </code>
                </div>
                <div className="detail-row">
                  <span>包管理器</span>
                  <span className="ellipsis">
                    {current?.package_manager
                      ? `${current.package_manager.name ?? "—"} ${
                          current.package_manager.version ?? ""
                        }`.trim()
                      : "—"}
                  </span>
                </div>
                <div className="detail-row">
                  <span>托管模式</span>
                  <span>{mode.label}</span>
                </div>
              </section>

              <details className="panel collapsible" open>
                <summary className="panel-head">
                  PATH / Shim 明细
                  {pathAudit?.warnings.length ? (
                    <span className="tag warn">{pathAudit.warnings.length} 警告</span>
                  ) : null}
                </summary>
                <div className="audit-list compact">
                  {pathAudit ? (
                    <>
                      {pathAudit.tools
                        .filter((t) => ["node", "npm", "pnpm", "yarn", "bun"].includes(t.tool))
                        .map((t) => (
                          <div className="audit-row" key={t.tool}>
                            <span
                              className={`badge ${!t.shim_exists || !t.managed ? "danger" : "ok"}`}
                            >
                              {!t.shim_exists ? "缺失" : !t.managed ? "非托管" : "生效"}
                            </span>
                            <div className="audit-main">
                              <div className="audit-tool">{t.tool}</div>
                              <code className="path-text" title={t.hits[0] ?? t.shim_path}>
                                {t.hits[0] ?? t.shim_path}
                              </code>
                            </div>
                          </div>
                        ))}
                      {pathAudit.vp_candidates.length ? (
                        <div className="audit-sub-title">vp CLI 副本</div>
                      ) : null}
                      {pathAudit.vp_candidates.map((c) => (
                        <div className="audit-row" key={c.path}>
                          <span
                            className={`badge ${
                              c.scope === "global"
                                ? "neutral"
                                : c.scope === "project"
                                  ? "ok"
                                  : "warn"
                            }`}
                          >
                            {c.scope === "global"
                              ? "全局"
                              : c.scope === "project"
                                ? "项目内"
                                : "未知"}
                          </span>
                          <div className="audit-main">
                            <div className="audit-tool">
                              <code className="path-text audit-path" title={c.path}>
                                {c.path}
                              </code>
                              {c.primary ? <span className="muted small">· 当前使用</span> : null}
                            </div>
                            <div
                              className="muted small"
                              title={[c.project, c.global_root].filter(Boolean).join(" · ")}
                            >
                              {c.version ? `v${c.version}` : "版本未知"}
                              {c.project ? ` · 所属项目 ${c.project}` : ""}
                              {c.global_root ? ` · 安装根 ${c.global_root}` : ""}
                            </div>
                          </div>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="muted">审计中…</div>
                  )}
                </div>
              </details>

              <section className="panel">
                <div className="panel-head">托管与维护</div>
                <div className="panel-actions">
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    onClick={() =>
                      void doMode(!(current?.node?.mode ?? "").toLowerCase().includes("managed"))
                    }
                  >
                    {(current?.node?.mode ?? "").toLowerCase().includes("managed")
                      ? "关闭托管 (off)"
                      : "开启托管 (on)"}
                  </button>
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    onClick={() => void doRefreshShims()}
                  >
                    刷新 shims
                  </button>
                  <button className="btn sm" disabled={!!busy} onClick={() => void doClean()}>
                    清理缓存
                  </button>
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    onClick={() => void doUnsetDefault()}
                  >
                    取消系统默认
                  </button>
                </div>
              </section>

              <details className="panel collapsible">
                <summary className="panel-head">跟随 dist-tag 的默认版本</summary>
                <div className="panel-actions">
                  <input
                    className="input mono"
                    placeholder="lts / latest / pnpm@latest-10"
                    value={tagDefault}
                    onChange={(e) => setTagDefault(e.target.value)}
                    style={{ flex: "1 1 140px" }}
                    title="设置后每次解析都会按标签重新取值（缓存 1 小时），大版本升级自动生效"
                  />
                  <button
                    className="btn sm"
                    disabled={!!busy || !tagDefault.trim()}
                    onClick={() => void doSetTagDefault()}
                  >
                    设为默认
                  </button>
                </div>
              </details>
            </aside>
          </div>
        </>
      ) : null}

      {tab === "project" ? (
        <>
          <div className="page-split">
            <div className="split-col split-main">
              <div className="panel project-bar">
                <Icon name="folder" size={14} />
                <code
                  className={`path-text ${projectDir ? "" : "muted"}`}
                  title={projectDir ?? undefined}
                >
                  {projectDir || "未选择项目目录"}
                </code>
                <button className="btn sm" onClick={() => void pickDir()} disabled={!!busy}>
                  选择目录
                </button>
              </div>

              <section className={`panel pin-section ${projectDir ? "fill" : ""}`}>
                <div className="panel-head">
                  实际命中的 pin
                  <span className="tag plain">就近优先 · 同目录专用文件优先</span>
                  <button
                    className="btn sm ghost"
                    onClick={() => void loadPinReport()}
                    disabled={!projectDir || pinReportBusy || !!busy}
                    style={{ marginLeft: "auto" }}
                  >
                    {pinReportBusy ? "读取中…" : "重新读取"}
                  </button>
                </div>
                {!projectDir ? (
                  <div className="muted small">选择项目目录后，只读解析 pin 文件。</div>
                ) : pinReportBusy && !pinReport ? (
                  <div className="hint" style={{ margin: 0 }}>
                    <span className="spinner dark" /> 正在读取 pin 文件…
                  </div>
                ) : pinReport ? (
                  <div className={`card pin-report ${effectivePins ? "" : "empty"}`}>
                    {(pinReport.entries.filter((e) => e.effective).length ?? 0) === 0 ? (
                      <>
                        <div className="hint" style={{ margin: 0 }}>
                          未发现 pin 文件，vp 会沿上层继续查找或使用全局默认。
                        </div>
                        <div className="detail-list" style={{ marginTop: 8 }}>
                          <div className="detail-row">
                            <span>搜索起点</span>
                            <span className="ellipsis" title={projectDir ?? undefined}>
                              {projectDir}
                            </span>
                          </div>
                          <div className="detail-row">
                            <span>查找范围</span>
                            <span>当前目录及上层目录，同目录专用文件优先</span>
                          </div>
                          <div className="detail-row">
                            <span>未命中时</span>
                            <span>
                              使用全局默认
                              {current?.node?.version
                                ? `（Node ${displayVersion(current.node.version)}）`
                                : ""}
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="pin-layer-list">
                        {pinReport.entries
                          .filter((e) => e.effective)
                          .map((e) => (
                            <div className="pin-layer" key={`${e.path}-${e.kind}`}>
                              <span className="badge neutral">{e.key}</span>
                              <div className="pin-layer-main">
                                <div className="pin-layer-value">
                                  <code>{e.raw}</code>
                                  <span className="muted"> · {e.kind}</span>
                                </div>
                                <code className="path-text" title={e.path}>
                                  {e.path}
                                </code>
                              </div>
                              {e.depth > 0 ? (
                                <span
                                  className="badge warn"
                                  title="来自上层目录，会影响其下所有子目录"
                                >
                                  上层目录
                                </span>
                              ) : null}
                              <span className="badge ok">生效</span>
                            </div>
                          ))}
                      </div>
                    )}

                    {pinReport.entries.filter((e) => !e.effective).length > 0 ? (
                      <details className="pin-shadowed">
                        <summary>
                          {pinReport.entries.filter((e) => !e.effective).length} 条被更近的 pin 覆盖
                        </summary>
                        {pinReport.entries
                          .filter((e) => !e.effective)
                          .map((e) => (
                            <div className="pin-layer dim" key={`${e.path}-${e.kind}`}>
                              <span className="badge neutral">{e.key}</span>
                              <div className="pin-layer-main">
                                <div className="pin-layer-value">
                                  <code>{e.raw}</code>
                                  <span className="muted"> · {e.kind}</span>
                                </div>
                                <code className="path-text" title={e.path}>
                                  {e.path}
                                </code>
                              </div>
                              <span className="badge neutral">被覆盖</span>
                            </div>
                          ))}
                      </details>
                    ) : null}

                    {pinReport.conflicts.map((c) => (
                      <div className="inline-warn danger" key={`${c.dir}-${c.key}`}>
                        <strong>{c.key}</strong> 在同一目录出现不同值：{c.values.join(" / ")}
                        <span className="muted">（{c.dir}）</span>
                      </div>
                    ))}
                    {pinReport.warnings.map((w) => (
                      <div className="inline-warn" key={w}>
                        {w}
                      </div>
                    ))}
                    {lastBackupDir ? (
                      <div className="pin-backup-row">
                        <span className="muted">最近备份：</span>
                        <code className="path-text" title={lastBackupDir}>
                          {lastBackupDir}
                        </code>
                        <button
                          className="btn sm ghost"
                          onClick={() => void launchTarget(lastBackupDir)}
                        >
                          打开目录
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {pinDraft ? (
                <section className="section">
                  <div className="section-head">
                    <span className="section-icon">
                      <Icon name="edit" size={14} />
                    </span>
                    <h4 className="section-title">
                      {pinDraft.mode === "unpin" ? "取消固定的变更预览" : "固定版本的变更预览"}
                    </h4>
                    <span className="section-count">确认前不会写入</span>
                  </div>
                  <div className="card pin-preview">
                    {pinDraft.changes.length === 0 ? (
                      <div className="hint" style={{ margin: 0 }}>
                        没有检测到需要变更的文件。
                      </div>
                    ) : null}
                    {pinDraft.changes.map((c) => {
                      const outside = !!projectDir && !pathInside(projectDir, c.path);
                      return (
                        <div className={`pin-change ${c.action}`} key={`${c.path}-${c.kind}`}>
                          <div className="pin-change-head">
                            <span
                              className={`badge ${
                                c.action === "remove"
                                  ? "danger"
                                  : c.action === "unchanged"
                                    ? "neutral"
                                    : "warn"
                              }`}
                            >
                              {c.action === "create"
                                ? "新建"
                                : c.action === "update"
                                  ? "修改"
                                  : c.action === "remove"
                                    ? "移除"
                                    : "无变化"}
                            </span>
                            <code className="path-text" title={c.path}>
                              {c.path}
                            </code>
                            {outside ? <span className="badge danger">项目目录之外</span> : null}
                          </div>
                          {c.before ? <div className="pin-diff minus">- {c.before}</div> : null}
                          {c.after ? <div className="pin-diff plus">+ {c.after}</div> : null}
                        </div>
                      );
                    })}
                    {pinDraft.changes.some(
                      (c) => !!projectDir && !pathInside(projectDir, c.path),
                    ) ? (
                      <div className="inline-warn danger">
                        有文件位于项目目录之外（通常是上层 workspace
                        根）。写入后会影响该目录下的其它项目，请确认路径无误。
                      </div>
                    ) : null}
                    <div className="hint">
                      预览为本地推断，实际写入以 vp 输出为准；执行前会自动备份将被修改的文件。
                    </div>
                    <div className="row">
                      <button
                        className="btn"
                        onClick={() => setPinDraft(null)}
                        disabled={pinDraftBusy || !!busy}
                      >
                        放弃
                      </button>
                      <button
                        className="btn primary"
                        onClick={() => void executePinDraft()}
                        disabled={pinDraftBusy || !!busy}
                      >
                        {pinDraft.mode === "unpin" ? "确认取消固定" : "确认写入"}
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}

              <div className="project-foot">
                <section className="panel">
                  <div className="panel-head">最近备份</div>
                  {lastBackupDir ? (
                    <div className="row" style={{ gap: 6 }}>
                      <code className="path-text" title={lastBackupDir}>
                        {lastBackupDir}
                      </code>
                      <button
                        className="btn sm ghost"
                        onClick={() => void launchTarget(lastBackupDir)}
                      >
                        打开
                      </button>
                    </div>
                  ) : (
                    <div className="muted small">
                      尚未产生备份。确认写入 pin 前会自动备份将被修改的文件。
                    </div>
                  )}
                </section>

                <details className="panel collapsible" open>
                  <summary className="panel-head">pin 文件说明</summary>
                  <div className="detail-list">
                    <div className="detail-row">
                      <span>自动</span>
                      <span>由 Vite+ 按就近优先选择目标文件</span>
                    </div>
                    <div className="detail-row">
                      <span>.node-version</span>
                      <span>单行版本号，兼容 nvm / fnm / volta</span>
                    </div>
                    <div className="detail-row">
                      <span>.nvmrc</span>
                      <span>nvm 原生格式，通常只写 Node 版本</span>
                    </div>
                    <div className="detail-row">
                      <span>devEngines</span>
                      <span>写入 package.json，声明运行时与包管理器</span>
                    </div>
                    <div className="detail-row">
                      <span>packageManager</span>
                      <span>写入 package.json 的包管理器字段</span>
                    </div>
                  </div>
                  <div className="muted small" style={{ marginTop: 8 }}>
                    同目录专用文件优先于上层目录；离项目最近的 pin 生效。
                  </div>
                </details>
              </div>
            </div>

            <aside className="split-col split-side">
              <section className="panel pin-form">
                <div className="panel-head">固定版本（pin）</div>
                <div className="card pin-card">
                  <div className="row" style={{ marginBottom: 8 }}>
                    <input
                      className="input mono"
                      placeholder="要固定的版本，例如：22.11.0 pnpm@10.18.0"
                      value={pinSpecs}
                      onChange={(e) => setPinSpecs(e.target.value)}
                      style={{ flex: "1 1 280px" }}
                    />
                    <select
                      className="select"
                      style={{ width: 160 }}
                      value={pinTarget}
                      onChange={(e) => setPinTarget(e.target.value)}
                      title="实际写入哪个文件 / 字段；自动时由 Vite+ 判断"
                    >
                      {PIN_TARGETS.map((t) => (
                        <option key={t.id} value={t.id}>
                          目标：{t.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn primary"
                      disabled={!!busy || !pinSpecs.trim()}
                      onClick={() => void doPinInput()}
                    >
                      固定到项目
                    </button>
                  </div>
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={pinForce}
                        onChange={(e) => setPinForce(e.target.checked)}
                      />
                      覆盖已有固定（--force）
                    </label>
                    <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={pinNoInstall}
                        onChange={(e) => setPinNoInstall(e.target.checked)}
                      />
                      跳过预下载（--no-install）
                    </label>
                  </div>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  项目环境
                  <span className="tag plain">按 pin / packageManager 装齐</span>
                </div>
                <div className="panel-actions">
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    onClick={() => void doInstallProjectEnv()}
                    title="vp env install：按项目的 pin / packageManager 一次性装齐 Node.js 与包管理器"
                  >
                    <Icon name="download" size={14} />
                    安装项目环境
                  </button>
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    onClick={() => void doInstallProjectDeps()}
                    title="vp install：按项目 package.json 安装依赖；不会改动 Node / 包管理器版本"
                  >
                    <Icon name="package" size={14} />
                    安装项目依赖
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => goTab("diagnostics")}
                    title="doctor 只在诊断页提供，这里仅跳转"
                  >
                    <Icon name="shield" size={14} />
                    去诊断检查
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">取消项目固定</div>
                <div className="panel-actions">
                  <select
                    className="select"
                    style={{ width: 138 }}
                    value={unpinScope}
                    onChange={(e) => setUnpinScope(e.target.value)}
                    title="留空 = 同时移除 Node 与包管理器固定"
                  >
                    <option value="">取消固定：全部</option>
                    <option value="node">取消固定：node</option>
                    <option value="pm">取消固定：pm</option>
                    <option value="pnpm">取消固定：pnpm</option>
                    <option value="npm">取消固定：npm</option>
                    <option value="yarn">取消固定：yarn</option>
                    <option value="bun">取消固定：bun</option>
                  </select>
                  <select
                    className="select"
                    style={{ width: 138 }}
                    value={unpinTarget}
                    onChange={(e) => setUnpinTarget(e.target.value)}
                    title="只移除指定来源里的固定，留空则由 Vite+ 自动判断"
                  >
                    {PIN_TARGETS.map((t) => (
                      <option key={t.id} value={t.id}>
                        来源：{t.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn sm danger"
                    disabled={!!busy}
                    onClick={() => void doUnpin()}
                  >
                    <Icon name="x" size={13} />
                    取消固定
                  </button>
                </div>
              </section>

              <section className="panel fill">
                <div className="panel-head">固定与安装的区别</div>
                <div className="detail-list">
                  <div className="detail-row">
                    <span>固定（pin）</span>
                    <span>只写入版本文件，不改全局环境</span>
                  </div>
                  <div className="detail-row">
                    <span>安装项目环境</span>
                    <span>按 pin / packageManager 装齐运行时</span>
                  </div>
                  <div className="detail-row">
                    <span>安装依赖</span>
                    <span>读取 package.json，不改变版本</span>
                  </div>
                </div>
              </section>
            </aside>
          </div>
        </>
      ) : null}

      {tab === "diagnostics" ? (
        <>
          <div className="diag-head">
            <div className="hint">只读检查，不会修改环境；异常项会附带可执行的修复建议。</div>
            <div className="spacer" />
            <button className="btn sm" onClick={() => void copyDiagnostics()}>
              复制诊断摘要
            </button>
          </div>
          <div className="tool-grid">
            <div className="tool-card">
              <div className="tool-card-head">
                <span className="tool-icon violet">
                  <Icon name="layers" size={16} />
                </span>
                <div className="tool-card-titles">
                  <h4 className="tool-title">当前环境摘要</h4>
                  <p className="tool-desc">解析结果与副本归属；无需运行命令即可查看。</p>
                </div>
              </div>
              <div className="detail-list">
                <div className="detail-row">
                  <span>vp</span>
                  <span className="ellipsis" title={ensure.path ?? vpPath ?? undefined}>
                    {ensure.version ? `v${ensure.version}` : "—"}
                    {` · ${ensure.path ?? vpPath ?? "未检测到"}`}
                  </span>
                </div>
                <div className="detail-row">
                  <span>托管模式</span>
                  <span>{modeInfo(current?.node?.mode).label}</span>
                </div>
                <div className="detail-row">
                  <span>shim 目录</span>
                  <span className="ellipsis" title={pathAudit?.shim_dir}>
                    {pathAudit?.shim_dir ?? "审计中…"}
                  </span>
                </div>
                <div className="detail-row">
                  <span>项目目录</span>
                  <span className="ellipsis" title={projectDir ?? undefined}>
                    {projectDir || "未选择"}
                  </span>
                </div>
                <div className="detail-row">
                  <span>PATH 警告</span>
                  <span>
                    {pathAudit?.warnings.length
                      ? `${pathAudit.warnings.length} 条，去环境页处理`
                      : "无"}
                  </span>
                </div>
              </div>
              {pathAudit?.vp_candidates.length ? (
                <div className="muted small" style={{ marginTop: 8 }}>
                  vp 副本 {pathAudit.vp_candidates.length} 个 · 项目内{" "}
                  {pathAudit.vp_candidates.filter((c) => c.scope === "project").length} · 全局{" "}
                  {pathAudit.vp_candidates.filter((c) => c.scope === "global").length} · 未知{" "}
                  {pathAudit.vp_candidates.filter((c) => c.scope === "unknown").length}
                </div>
              ) : null}
              <div className="tool-foot">数据来自 vp env current / list 与 PATH 审计</div>
            </div>

            <div className="tool-card">
              <div className="tool-card-head">
                <span className="tool-icon indigo">
                  <Icon name="shield" size={16} />
                </span>
                <div className="tool-card-titles">
                  <h4 className="tool-title">doctor 自检</h4>
                  <p className="tool-desc">核对 PATH、shim 与项目固定的实际解析结果。</p>
                </div>
              </div>
              <div className="toolbar">
                <button className="btn" disabled={!!busy} onClick={() => void runDoctorReport()}>
                  <Icon name="shield" size={13} />
                  运行 doctor
                </button>
              </div>
              {doctorReport ? (
                <div className="diag-scroll">
                  <DiagReportView report={doctorReport} />
                </div>
              ) : (
                <div className="tool-empty">
                  <Icon name="shield" size={20} />
                  <span>尚未运行 doctor</span>
                  <span className="muted small">异常项会附带可执行的修复建议</span>
                </div>
              )}
            </div>

            <div className="tool-card">
              <div className="tool-card-head">
                <span className="tool-icon cyan">
                  <Icon name="search" size={16} />
                </span>
                <div className="tool-card-titles">
                  <h4 className="tool-title">which 路径与来源</h4>
                  <p className="tool-desc">实际命中的可执行文件、来源与版本；附带 PATH 设置。</p>
                </div>
              </div>
              <div className="toolbar">
                <select
                  className="select"
                  style={{ width: 110 }}
                  value={whichTool}
                  onChange={(e) => setWhichTool(e.target.value)}
                >
                  {["node", "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={!!busy} onClick={() => void runWhichAndPrint()}>
                  <Icon name="search" size={13} />
                  查询
                </button>
              </div>
              {whichReport ? (
                <div className="diag-scroll">
                  <WhichReportView report={whichReport} />
                </div>
              ) : (
                <div className="tool-empty">
                  <Icon name="search" size={20} />
                  <span>尚未查询</span>
                  <span className="muted small">选择工具后查询实际路径，同时读取 PATH 设置</span>
                </div>
              )}
              {printRaw ? (
                <details className="diag-raw">
                  <summary>vp env print（PATH / 默认版本）</summary>
                  <pre>{printRaw}</pre>
                </details>
              ) : null}
            </div>

            <div className="tool-card">
              <div className="tool-card-head">
                <span className="tool-icon cyan">
                  <Icon name="terminal" size={16} />
                </span>
                <div className="tool-card-titles">
                  <h4 className="tool-title">在环境中执行命令（exec）</h4>
                  <p className="tool-desc">在 Vite+ 解析出的 Node 与包管理器环境里临时运行命令。</p>
                </div>
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <input
                  className="input mono"
                  placeholder="要执行的命令，例如：node -v"
                  value={execCmd}
                  onChange={(e) => setExecCmd(e.target.value)}
                  style={{ flex: "1 1 240px" }}
                />
                <button
                  className="btn"
                  disabled={!!busy || !execCmd.trim()}
                  onClick={() =>
                    void runOp(`执行 ${execCmd.trim()}`, () =>
                      vpEnvExec(
                        splitCommand(execCmd),
                        vpPath,
                        projectDir,
                        execNode.trim() || null,
                        execPm.trim() || null,
                        execNpm.trim() || null,
                      ),
                    )
                  }
                >
                  执行
                </button>
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <input
                  className="input mono"
                  placeholder="--node 覆盖"
                  value={execNode}
                  onChange={(e) => setExecNode(e.target.value)}
                  style={{ flex: "1 1 0" }}
                />
                <input
                  className="input mono"
                  placeholder="--package-manager 覆盖"
                  value={execPm}
                  onChange={(e) => setExecPm(e.target.value)}
                  style={{ flex: "1 1 0" }}
                />
                <input
                  className="input mono"
                  placeholder="--npm 覆盖"
                  value={execNpm}
                  onChange={(e) => setExecNpm(e.target.value)}
                  style={{ flex: "1 1 0" }}
                />
              </div>
              <div className="tool-empty">
                <Icon name="terminal" size={20} />
                <span>结果输出到页面底部控制台</span>
                <span className="muted small">
                  覆盖框留空则用当前解析结果；命令在
                  {projectDir ? "所选项目目录" : "当前目录"}下运行。
                </span>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {consoleText ? (
        <ConsolePanel
          text={consoleText}
          source={consoleSource}
          at={consoleAt}
          onClear={() => {
            setConsoleText("");
            setConsoleSource("");
            setConsoleAt(null);
          }}
        />
      ) : null}
    </div>
  );
}
