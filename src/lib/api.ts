import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/* ------------------------------------------------------------------ 配置 */

export interface Config {
  vpPath?: string | null;
  lastProjectDir?: string | null;
  /** 窗口是否始终置顶 */
  alwaysOnTop: boolean;
}

export const emptyConfig = (): Config => ({
  vpPath: null,
  lastProjectDir: null,
  alwaysOnTop: false,
});

export const loadConfig = () => invoke<Config>("load_config");
export const saveConfig = (config: Config) => invoke<void>("save_config", { config });
export const configDir = () => invoke<string>("config_dir");
/** 可用的配置备份路径（不存在时为 null） */
export const configBackupInfo = () => invoke<string | null>("config_backup_info");
/** 用 config.json.bak 恢复配置（当前损坏时不会覆盖备份） */
export const restoreConfigBackup = () => invoke<Config>("restore_config_backup");

/* ---------------------------------------------------------------- 窗口 */

/** 置顶开关（立即作用于窗口） */
export const setAlwaysOnTop = (on: boolean) => invoke<void>("set_always_on_top", { on });

/** 真正退出程序 */
export const quitApp = () => invoke<void>("quit_app");

/* -------------------------------------------------------------- 系统操作 */

export const launchTarget = (path: string, args?: string[], cwd?: string | null) =>
  invoke<void>("launch_target", { path, args: args ?? [], cwd: cwd ?? null });

export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** 手动选择 vp 可执行文件 */
export async function pickVpBinary(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "选择 vp 可执行文件",
    filters: [{ name: "可执行程序", extensions: ["exe", "cmd", "bat", "*"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** 选择项目目录（用于 pin / doctor） */
export async function pickProjectDir(startDir?: string | null): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: true,
    title: "选择项目目录",
    defaultPath: startDir ?? undefined,
  });
  return typeof selected === "string" ? selected : null;
}

/* ---------------------------------------------------------------- Vite+ */

export interface VpInstalledItem {
  version: string;
  current?: boolean;
  default?: boolean;
}

export interface VpRemoteItem {
  version: string;
  lts: string | null;
  latest: boolean;
  latest_lts: boolean;
  installed: boolean;
  current: boolean;
  default: boolean;
}

export interface VpListResult {
  node?: VpInstalledItem[];
  package_managers?: Record<string, VpInstalledItem[]>;
}

export interface VpRemoteResult {
  node?: VpRemoteItem[];
  package_managers?: Record<string, VpRemoteItem[]>;
}

export interface VpNodeCurrent {
  version?: string;
  source?: string;
  source_path?: string;
  project_root?: string;
  bin_path?: string;
  installed?: boolean;
  mode?: string;
}

export interface VpPackageManagerCurrent {
  name?: string;
  version?: string;
  source?: string;
  source_path?: string;
  project_root?: string;
  bin_paths?: Record<string, string>;
  installed?: boolean;
  mode?: string;
}

export interface VpCurrentResult {
  node?: VpNodeCurrent;
  package_manager?: VpPackageManagerCurrent;
}

const vpArg = (vpPath: string | null | undefined) => ({
  vpPath: vpPath && vpPath.trim() ? vpPath : null,
});

export const vpResolve = (vpPath?: string | null) => invoke<string>("vp_resolve", vpArg(vpPath));

export const vpVersion = (vpPath?: string | null) => invoke<string>("vp_version", vpArg(vpPath));

/** 启动自检 / 安装 / 升级 Vite+ 的进度事件 */
export const VP_STATUS_EVENT = "flowdeck:vp-status";

export interface VpStatusPayload {
  phase: string;
  message: string;
}

export interface VpEnsureResult {
  ok: boolean;
  compliant: boolean;
  path?: string | null;
  version?: string | null;
  previous_version?: string | null;
  installed: boolean;
  upgraded: boolean;
  actions: string[];
  log: string;
  error?: string | null;
  /** 多 vp 副本 / 版本不一致等提示 */
  warnings?: string[];
}

export interface VpProbeResult {
  path: string;
  version?: string | null;
  verified: boolean;
  warnings: string[];
}

/**
 * 检测 Vite+ 环境。
 * `allowMutation = false`（默认）只检测；为 true 时缺失会安装、过低会 upgrade。
 */
export const vpEnsure = (vpPath?: string | null, allowMutation = false) =>
  invoke<VpEnsureResult>("vp_ensure", {
    ...vpArg(vpPath),
    allowMutation,
  });

/** 设置页「检测」：只定位 + 校验身份，不改环境 */
export const vpProbe = (vpPath?: string | null) => invoke<VpProbeResult>("vp_probe", vpArg(vpPath));

export const vpEnvCurrent = (vpPath?: string | null, cwd?: string | null) =>
  invoke<VpCurrentResult>("vp_env_current", { ...vpArg(vpPath), cwd: cwd ?? null });

export const vpEnvList = (vpPath?: string | null) =>
  invoke<VpListResult>("vp_env_list", vpArg(vpPath));

export const vpEnvListRemote = (
  vpPath?: string | null,
  selector?: string,
  lts?: boolean,
  all?: boolean,
) =>
  invoke<VpRemoteResult>("vp_env_list_remote", {
    ...vpArg(vpPath),
    selector: selector ?? null,
    lts: !!lts,
    all: !!all,
  });

/** `vp env install [spec]`；spec 留空时安装所选项目解析出的完整环境 */
export const vpEnvInstall = (spec: string | null, vpPath?: string | null, cwd?: string | null) =>
  invoke<string>("vp_env_install", {
    ...vpArg(vpPath),
    spec: spec && spec.trim() ? spec.trim() : null,
    cwd: cwd ?? null,
  });

export const vpEnvUninstall = (spec: string, vpPath?: string | null) =>
  invoke<string>("vp_env_uninstall", { ...vpArg(vpPath), spec });

export const vpEnvPin = (
  cwd: string,
  specs: string[],
  vpPath?: string | null,
  target?: string | null,
  force?: boolean,
  noInstall?: boolean,
) =>
  invoke<string>("vp_env_pin", {
    ...vpArg(vpPath),
    cwd,
    specs,
    target: target ?? null,
    force: !!force,
    noInstall: !!noInstall,
  });

/** `vp env unpin [scope] [--target <target>]` */
export const vpEnvUnpin = (
  cwd: string,
  scope: string | null,
  vpPath?: string | null,
  target?: string | null,
) =>
  invoke<string>("vp_env_unpin", {
    ...vpArg(vpPath),
    cwd,
    scope: scope && scope.trim() ? scope.trim() : null,
    target: target && target.trim() ? target.trim() : null,
  });

export const vpEnvDefault = (spec: string | null, unset: boolean, vpPath?: string | null) =>
  invoke<string>("vp_env_default", { ...vpArg(vpPath), spec, unset });

export const vpEnvClean = (selector: string | null, vpPath?: string | null) =>
  invoke<string>("vp_env_clean", { ...vpArg(vpPath), selector });

/** 传入 cwd 才会命中项目里的 pin */
export const vpEnvWhich = (tool: string, vpPath?: string | null, cwd?: string | null) =>
  invoke<string>("vp_env_which", { ...vpArg(vpPath), tool, cwd: cwd ?? null });

export const vpEnvMode = (managed: boolean, selector: string | null, vpPath?: string | null) =>
  invoke<string>("vp_env_mode", { ...vpArg(vpPath), selector, managed });

/** `vp env setup [--refresh] [--env-only]` */
export const vpEnvSetup = (refresh: boolean, envOnly: boolean, vpPath?: string | null) =>
  invoke<string>("vp_env_setup", { ...vpArg(vpPath), refresh, envOnly: !!envOnly });

export const vpEnvPrint = (selector: string | null, vpPath?: string | null, cwd?: string | null) =>
  invoke<string>("vp_env_print", {
    ...vpArg(vpPath),
    selector,
    cwd: cwd ?? null,
  });

/** `vp env use [spec...] [--unset] [--no-install] [--silent-if-unchanged]` */
export const vpEnvUse = (
  specs: string[],
  unset: boolean,
  vpPath?: string | null,
  noInstall?: boolean,
  silentIfUnchanged?: boolean,
) =>
  invoke<string>("vp_env_use", {
    ...vpArg(vpPath),
    specs,
    unset,
    noInstall: !!noInstall,
    silentIfUnchanged: !!silentIfUnchanged,
  });

/**
 * `vp env exec [--node <spec>] [--npm <spec>] [--package-manager <spec>] <command...>`
 * 在解析出的环境里执行命令，可临时覆盖 Node / npm / 包管理器版本。
 */
export const vpEnvExec = (
  command: string[],
  vpPath?: string | null,
  cwd?: string | null,
  node?: string | null,
  packageManager?: string | null,
  npm?: string | null,
) =>
  invoke<string>("vp_env_exec", {
    ...vpArg(vpPath),
    command,
    cwd: cwd ?? null,
    node: node ?? null,
    packageManager: packageManager ?? null,
    npm: npm ?? null,
  });

/** 把命令行字符串按空白切分，支持单引号 / 双引号包裹的参数 */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  const re = /[^\s"']+|"[^"]*"|'[^']*'/g;
  for (const m of input.match(re) ?? []) {
    const v = m.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (v) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------ 项目 Pin */

export interface PinEntry {
  path: string;
  dir: string;
  file: string;
  kind: string;
  key: string;
  raw: string;
  value: string;
  depth: number;
  effective: boolean;
  shadowed_by: string | null;
}

export interface PinConflict {
  key: string;
  dir: string;
  values: string[];
}

export interface PinReport {
  cwd: string;
  root: string;
  entries: PinEntry[];
  conflicts: PinConflict[];
  warnings: string[];
}

export interface PinChange {
  path: string;
  file: string;
  kind: string;
  action: "create" | "update" | "remove" | "unchanged";
  key: string;
  before: string | null;
  after: string | null;
  predicted: boolean;
}

export interface PinBackupResult {
  dir: string;
  files: string[];
}

export const pinInspect = (cwd: string) => invoke<PinReport>("pin_inspect", { cwd });

export const pinPreview = (cwd: string, specs: string[], target: string | null, unpin: boolean) =>
  invoke<PinChange[]>("pin_preview", {
    cwd,
    specs,
    target: target && target.trim() ? target.trim() : null,
    unpin,
  });

export const pinBackup = (files: string[]) => invoke<PinBackupResult>("pin_backup", { files });

/* ------------------------------------------------------------ 取消 / 诊断 */

export interface CancelResult {
  cancelled: boolean;
  pid: number | null;
  exited: boolean;
  message: string;
}

export const vpCancel = () => invoke<CancelResult>("vp_cancel");

export interface DiagItem {
  level: "ok" | "warn" | "error" | "info";
  text: string;
  suggestion: string | null;
}

export interface DoctorReport {
  raw: string;
  items: DiagItem[];
  summary: string;
  errors: number;
  warnings: number;
  healthy: boolean;
}

export interface WhichReport {
  tool: string;
  raw: string;
  path: string;
  exists: boolean;
  /** `Version:` 行（Node / 包管理器版本） */
  version: string | null;
  /** `Package:` 行，例如 bun@1.4.4 */
  package: string | null;
  /** `Source:` 行（解析来源） */
  source: string | null;
  suggestion: string | null;
}

export const vpDoctorReport = (
  vpPath?: string | null,
  cwd?: string | null,
  scope?: string | null,
) =>
  invoke<DoctorReport>("vp_doctor_report", {
    ...vpArg(vpPath),
    cwd: cwd ?? null,
    scope: scope && scope.trim() ? scope.trim() : null,
  });

export const vpWhichReport = (tool: string, vpPath?: string | null, cwd?: string | null) =>
  invoke<WhichReport>("vp_which_report", { ...vpArg(vpPath), tool, cwd: cwd ?? null });

/* ------------------------------------------------------- PATH / shim / 自身升级 */

export interface ToolPathAudit {
  tool: string;
  /** vp 应生成的 shim 路径 */
  shim_path: string;
  shim_exists: boolean;
  /** PATH 中所有命中，按优先级排序；空表示未命中 */
  hits: string[];
  /** 实际生效路径是否由 Vite+ 管理（shim 或 vp 自己的 js_runtime） */
  managed: boolean;
  /** PATH 中不属于 Vite+ 的命中，可能来自系统安装 */
  foreign_hits: string[];
}

/** 一个 vp 副本的归属：global=全局安装，project=项目本地依赖，unknown=无法确认 */
export interface VpCandidate {
  path: string;
  version: string | null;
  scope: "global" | "project" | "unknown";
  /** scope=global 时的安装根目录 */
  global_root: string | null;
  /** scope=project 时的所属项目目录 */
  project: string | null;
  primary: boolean;
}

export interface PathAudit {
  shim_dir: string;
  tools: ToolPathAudit[];
  warnings: string[];
  /** 所有 vp 副本及归属，只作为普通信息展示 */
  vp_candidates: VpCandidate[];
}

/** 实时审计 PATH 与 shim，不缓存 */
export const envPathAudit = (vpPath?: string | null) =>
  invoke<PathAudit>("env_path_audit", vpArg(vpPath));

export interface UpgradeCheck {
  current: string | null;
  latest: string | null;
  up_to_date: boolean;
  raw: string;
}

/** `vp upgrade --check`：只检查 Vite+ 自身是否有新版本 */
export const vpUpgradeCheck = (vpPath?: string | null) =>
  invoke<UpgradeCheck>("vp_upgrade_check", vpArg(vpPath));

/** `vp upgrade`：升级 Vite+ 自身（会改全局 CLI） */
export const vpUpgrade = (vpPath?: string | null) =>
  invoke<string>("vp_upgrade_latest", vpArg(vpPath));

/** `vp install`：在项目目录按 package.json 安装依赖 */
export const vpInstallProject = (cwd: string, vpPath?: string | null) =>
  invoke<string>("vp_install_project", { ...vpArg(vpPath), cwd });

/** 安装阶段进度事件（下载 / 解压 / 校验） */
export const INSTALL_PHASE_EVENT = "flowdeck:env-phase";

/* ---------------------------------------------------------------- 工具 */

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
