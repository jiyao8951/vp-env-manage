import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  INSTALL_PHASE_EVENT,
  errText,
  vpCancel,
  type PathAudit,
  type PinReport,
  type VpCurrentResult,
  type VpListResult,
  type VpRemoteItem,
  type VpRemoteResult,
} from "./api";
import { displayVersion, parseSemver } from "./version";
import type { IconName } from "../components/Icon";
import type { StatusTone } from "../components/StatusCard";

export type Notify = (kind: "info" | "success" | "error", title: string, text?: string) => void;

/* ------------------------------------------------------------ 常量与小工具 */

export const SELECTORS: { id: string; label: string; isNode: boolean }[] = [
  { id: "node", label: "Node.js", isNode: true },
  { id: "pnpm", label: "pnpm", isNode: false },
  { id: "npm", label: "npm", isNode: false },
  { id: "yarn", label: "Yarn", isNode: false },
  { id: "bun", label: "Bun", isNode: false },
];

export const PIN_TARGETS = [
  { id: "", label: "自动" },
  { id: "node-version", label: ".node-version" },
  { id: "nvmrc", label: ".nvmrc" },
  { id: "dev-engines", label: "devEngines" },
  { id: "package-manager", label: "packageManager" },
];

/** 刷新合并窗口：只用于压掉「聚焦 + 可见」同帧双触发，不是缓存 */
export const TTL_LOCAL = 2_000;
/** 本地快照比这个时间新时，切回页面只渲染快照，不再跑后台核对 */
export const REVALIDATE_MS = 30_000;
/** 远端版本列表缓存有效期 */
export const TTL_REMOTE = 5 * 60_000;
/** 远端请求超过这个时间给出「网络较慢」提示 */
export const REMOTE_SLOW_MS = 20_000;

const NODE_MIN_LTS_MAJOR = 18;

/** 远端 Node 列表只留 18 及以后的 LTS 线，外加最新大版本 */
export function filterNodeRemote(items: VpRemoteItem[]): VpRemoteItem[] {
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
export function specFor(selector: string, version: string, bare: boolean): string {
  const v = displayVersion(version);
  if (selector === "node" && bare) return v;
  return `${selector}@${v}`;
}

/** 判断路径是否位于指定目录内（用于提示「会改到上层目录」） */
export function pathInside(parent: string, child: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "\\")
      .replace(/\\+$/, "")
      .toLowerCase();
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a + "\\");
}

const REMOTE_CACHE_PREFIX = "flowdeck.remote.";

export function readRemoteCache(key: string): { at: number; data: VpRemoteResult } | null {
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

export function writeRemoteCache(key: string, data: VpRemoteResult) {
  try {
    localStorage.setItem(REMOTE_CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* 存储配额不足时静默忽略 */
  }
}

/* ------------------------------------------------------- 环境变更版本号 */

const REVISION_KEY = "flowdeck.envRevision";

/**
 * 每次成功执行会改变环境 / pin 的操作后刷新。
 * 快照里记下写入时的值，其它页面只要发现版本号变了，即使还在缓存窗口内也会重新核对，
 * 避免「系统页刚装好版本，切到项目页仍看到旧清单」。
 */
export function envRevision(): number {
  try {
    const v = Number(localStorage.getItem(REVISION_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function bumpEnvRevision() {
  try {
    // 取「当前时间」与「上一个值 + 1」的较大者，保证连续两次变更也能区分开
    localStorage.setItem(REVISION_KEY, String(Math.max(Date.now(), envRevision() + 1)));
  } catch {
    /* 存储不可用时忽略，退化为按时间窗口核对 */
  }
}

/* --------------------------------------------------- 已安装列表本地快照 */

const LOCAL_CACHE_PREFIX = "flowdeck.installed.";

export interface InstalledSnapshot {
  at: number;
  /** 写入时的环境变更版本号，用于判断快照是否已过期 */
  rev: number;
  installed: VpListResult;
  pathAudit: PathAudit | null;
}

/**
 * 上次成功读取的「已安装版本 + PATH 审计」。
 * 切页会卸载系统页，没有快照时每次进入都要等 `vp env list` 跑完（数百毫秒到数秒），
 * 有快照则先用旧数据渲染，再在后台核对。
 */
export function readInstalledCache(key: string): InstalledSnapshot | null {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InstalledSnapshot>;
    if (typeof parsed.at !== "number" || !parsed.installed) return null;
    return {
      at: parsed.at,
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
      installed: parsed.installed,
      pathAudit: parsed.pathAudit ?? null,
    };
  } catch {
    return null;
  }
}

export function writeInstalledCache(
  key: string,
  installed: VpListResult,
  pathAudit: PathAudit | null,
) {
  try {
    localStorage.setItem(
      LOCAL_CACHE_PREFIX + key,
      JSON.stringify({
        at: Date.now(),
        rev: envRevision(),
        installed,
        pathAudit,
      } satisfies InstalledSnapshot),
    );
  } catch {
    /* 存储配额不足时静默忽略 */
  }
}

/** 结构化数据是否一致：一致时保留原引用，跳过无意义的重新渲染 */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------- 项目页本地快照 */

const PROJECT_CACHE_PREFIX = "flowdeck.project.";

export interface ProjectSnapshot {
  at: number;
  /** 写入时的环境变更版本号，用于判断快照是否已过期 */
  rev: number;
  current: VpCurrentResult | null;
  pinReport: PinReport | null;
  installed: VpListResult | null;
}

/**
 * 项目页的三份数据（vp env current / pin inspect / vp env list）都依赖真实目录，
 * 每次切回项目页都要重新跑一遍，体感是「进页面先等一会」。
 * 先渲染上次的快照，再在后台核对，数据一致时保留原引用不重渲染。
 */
export function readProjectCache(key: string): ProjectSnapshot | null {
  try {
    const raw = localStorage.getItem(PROJECT_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProjectSnapshot>;
    if (typeof parsed.at !== "number") return null;
    if (!parsed.current && !parsed.pinReport && !parsed.installed) return null;
    return {
      at: parsed.at,
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
      current: parsed.current ?? null,
      pinReport: parsed.pinReport ?? null,
      installed: parsed.installed ?? null,
    };
  } catch {
    return null;
  }
}

export function writeProjectCache(key: string, data: Omit<ProjectSnapshot, "at" | "rev">) {
  try {
    localStorage.setItem(
      PROJECT_CACHE_PREFIX + key,
      JSON.stringify({ at: Date.now(), rev: envRevision(), ...data } satisfies ProjectSnapshot),
    );
  } catch {
    /* 存储配额不足时静默忽略 */
  }
}

/** 把安装 / 卸载失败粗分为网络、权限、磁盘、残留等，给出可执行的下一步 */
export function classifyFailure(message: string): { label: string; tip: string } {
  const s = message.toLowerCase();
  if (s.includes("vp_env_forbidden") || s.includes("disabledbyenvforbidden")) {
    return {
      label: "系统工具链模式",
      tip: "检测到 VP_ENV_FORBIDDEN=1：vp 不再下载或管理 Node.js / 包管理器。取消该环境变量后重试。",
    };
  }
  if (
    ["network", "econn", "enotfound", "timed out", "timeout", "网络", "getaddrinfo", "proxy"].some(
      (k) => s.includes(k),
    )
  ) {
    return { label: "网络失败", tip: "检查网络 / 代理后重试；若列表已有缓存，可先离线查看。" };
  }
  if (["eacces", "eperm", "denied", "permission", "权限", "拒绝访问"].some((k) => s.includes(k))) {
    return { label: "权限不足", tip: "确认安装目录可写，避免使用受保护的 Program Files。" };
  }
  if (["enospc", "no space", "disk", "磁盘", "空间不足", "quota"].some((k) => s.includes(k))) {
    return { label: "磁盘空间不足", tip: "清理磁盘后重试，或先执行 vp env clean 释放运行时。" };
  }
  if (
    ["busy", "in use", "occupied", "占用", "already", "exists", "残留", "lock"].some((k) =>
      s.includes(k),
    )
  ) {
    return { label: "文件占用 / 残留", tip: "先关闭正在使用该版本的程序，再清理并重试。" };
  }
  return { label: "未知失败", tip: "可先执行 vp env list 核对状态，必要时清理未完成安装后重试。" };
}

export function summarizeOp(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const picked = lines.filter((l) =>
    /^(✓|✔|File:|Field:|Created\b|Updated\b|Pinned\b|Unpinned\b|Removed\b|No .*file|安装|升级)/.test(
      l,
    ),
  );
  return (picked.length ? picked : lines).slice(0, 8).join("\n");
}

export function clock(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 把 vp env current 返回的 mode 归一成可读状态 */
export function modeInfo(mode?: string | null): { label: string; tone: StatusTone } {
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

/** 把 PATH 审计归一成「shim 到底有没有真的生效」 */
export function shimInfo(
  audit: PathAudit | null,
  mode: { label: string; tone: StatusTone },
): { label: string; tone: StatusTone; sub: string; detail?: string } {
  if (!audit) return { label: mode.label, tone: mode.tone, sub: "正在审计 shim 与 PATH…" };
  const node = audit.tools.find((t) => t.tool === "node");
  if (!node)
    return { label: "未审计到 node", tone: "warn", sub: `shim 目录：${audit.shim_dir || "—"}` };
  if (!node.shim_exists)
    return {
      label: "shim 缺失",
      tone: "danger",
      sub: `预期位置：${node.shim_path}`,
      detail: audit.shim_dir,
    };
  if (node.hits.length === 0)
    return {
      label: "PATH 未命中",
      tone: "warn",
      sub: "shim 已生成，但当前进程 PATH 里没有它",
      detail: node.shim_path,
    };
  const first = node.hits[0];
  if (!node.managed)
    return {
      label: "系统优先",
      tone: "warn",
      sub: `PATH 首命中：${first}`,
      detail: node.shim_path,
    };
  return {
    label: samePath(first, node.shim_path) ? "托管已生效" : "托管已生效（runtime 直连）",
    tone: "ok",
    sub: `生效路径：${first}`,
    detail: audit.shim_dir,
  };
}

/** 状态卡的通用图标色 */
export const TONE_ICON: Record<StatusTone, IconName> = {
  ok: "check",
  warn: "alert",
  danger: "alert",
  info: "info",
  neutral: "info",
};

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <span className="skeleton-line w-100" key={i} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------- 共享操作执行逻辑 */

export interface OpFailure {
  label: string;
  message: string;
  retry: () => Promise<string>;
  quiet?: boolean;
}

export interface OpDone {
  label: string;
  text: string;
}

export interface VpOps {
  busy: string | null;
  busySince: number | null;
  opCancelled: boolean;
  installStage: { phase: string; message: string } | null;
  consoleText: string;
  consoleSource: string;
  consoleAt: number | null;
  opError: OpFailure | null;
  opResult: OpDone | null;
  failureInfo: { label: string; tip: string } | null;
  lastInstallSpec: string | null;
  setLastInstallSpec: (v: string | null) => void;
  /**
   * `quiet = true`：成功只发一个短 toast，不写控制台、不出成功反馈条，
   * 避免页面被撑开抖动；失败仍保留可重试的错误反馈。
   */
  runOp: (
    label: string,
    fn: () => Promise<string>,
    summarize?: (out: string) => string,
    quiet?: boolean,
  ) => Promise<boolean>;
  cancelOp: () => Promise<void>;
  retry: () => Promise<boolean>;
  clearConsole: () => void;
  clearError: () => void;
  clearResult: () => void;
}

/**
 * 所有会改变环境的命令都经过这里：进度、输出、失败重试、取消、完成后刷新。
 * `onDone` 由各视图提供自己的刷新实现，系统页与项目页互不共享数据。
 */
export function useVpOps(notify: Notify, onDone: () => Promise<void>): VpOps {
  const [busy, setBusy] = useState<string | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [opCancelled, setOpCancelled] = useState(false);
  const [installStage, setInstallStage] = useState<{ phase: string; message: string } | null>(null);
  const [consoleText, setConsoleText] = useState("");
  const [consoleSource, setConsoleSource] = useState("");
  const [consoleAt, setConsoleAt] = useState<number | null>(null);
  const [opError, setOpError] = useState<OpFailure | null>(null);
  const [opResult, setOpResult] = useState<OpDone | null>(null);
  const [lastInstallSpec, setLastInstallSpec] = useState<string | null>(null);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ phase: string; message: string }>(INSTALL_PHASE_EVENT, (e) => {
      if (!disposed) setInstallStage(e.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const runOp = useCallback(
    async (
      label: string,
      fn: () => Promise<string>,
      summarize?: (out: string) => string,
      quiet = false,
    ): Promise<boolean> => {
      setBusy(label);
      setBusySince(Date.now());
      setOpCancelled(false);
      setInstallStage(null);
      setOpError(null);
      setOpResult(null);
      setConsoleText("");
      setConsoleSource(label);
      setConsoleAt(Date.now());
      let ok = false;
      try {
        const out = await fn();
        if (!quiet) setConsoleText(out);
        const detail = summarize ? summarize(out) : "";
        if (summarize && !quiet) setOpResult({ label, text: detail });
        notify("success", label + " 完成", quiet ? undefined : detail || undefined);
        ok = true;
        // 环境已改变：让其它页面的快照立即失效，切回去时不必等缓存窗口
        bumpEnvRevision();
      } catch (e) {
        const msg = errText(e);
        if (!quiet) setConsoleText(msg);
        setOpError({ label, message: msg, retry: fn, quiet });
        notify(
          "error",
          label + " 失败",
          quiet
            ? msg
            : `${msg}\n\n可点击「重试」，或刷新后重新核对；若为安装中断，建议检查 vp env list，必要时执行 vp env clean。`,
        );
      } finally {
        try {
          await onDoneRef.current();
        } catch {
          /* 刷新失败不覆盖操作结果 */
        }
        setBusy(null);
        setBusySince(null);
        setInstallStage(null);
      }
      return ok;
    },
    [notify],
  );

  const cancelOp = useCallback(async () => {
    if (opCancelled) return;
    setOpCancelled(true);
    try {
      const r = await vpCancel();
      if (r.exited) notify("info", "已终止当前命令", r.message);
      else notify("error", "进程可能仍在运行", r.message);
    } catch (e) {
      notify("error", "取消失败", errText(e));
    }
  }, [opCancelled, notify]);

  const retry = useCallback(async () => {
    const failed = opError;
    if (!failed) return false;
    setOpError(null);
    return runOp(failed.label, failed.retry, undefined, failed.quiet);
  }, [opError, runOp]);

  return {
    busy,
    busySince,
    opCancelled,
    installStage,
    consoleText,
    consoleSource,
    consoleAt,
    opError,
    opResult,
    failureInfo: opError ? classifyFailure(opError.message) : null,
    lastInstallSpec,
    setLastInstallSpec,
    runOp,
    cancelOp,
    retry,
    clearConsole: () => {
      setConsoleText("");
      setConsoleSource("");
      setConsoleAt(null);
    },
    clearError: () => setOpError(null),
    clearResult: () => setOpResult(null),
  };
}
