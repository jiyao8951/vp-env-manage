import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  envPathAudit,
  errText,
  openUrl,
  vpEnvClean,
  vpEnvDefault,
  vpEnvInstall,
  vpEnvList,
  vpEnvListRemote,
  vpEnvMode,
  vpEnvSetup,
  vpEnvUninstall,
  type PathAudit,
  type VpEnsureResult,
  type VpInstalledItem,
  type VpListResult,
  type VpRemoteItem,
  type VpRemoteResult,
  type VpStatusPayload,
} from "../lib/api";
import { displayVersion, groupByMajor } from "../lib/version";
import { isNodeSpec } from "../lib/spec";
import {
  REMOTE_SLOW_MS,
  SELECTORS,
  SkeletonRows,
  TTL_LOCAL,
  TTL_REMOTE,
  clock,
  envRevision,
  filterNodeRemote,
  readRemoteCache,
  readInstalledCache,
  sameSnapshot,
  shimInfo,
  specFor,
  summarizeOp,
  useVpOps,
  writeInstalledCache,
  writeRemoteCache,
  type Notify,
} from "../lib/envShared";
import type { StatusTone } from "./StatusCard";
import ConsolePanel from "./ConsolePanel";
import Icon from "./Icon";
import { OperationFeedback, OperationProgress } from "./OperationFeedback";

interface Props {
  vpPath: string | null;
  notify: Notify;
  /** App 启动自检结果；系统页不接收任何项目目录 */
  ensure: VpEnsureResult | null;
  ensureBusy: boolean;
  ensurePhase: VpStatusPayload | null;
  onRecheck: () => void;
  onRepair: () => void;
}

async function confirm(message: string, title: string): Promise<boolean> {
  try {
    return await ask(message, { title, kind: "warning" });
  } catch {
    return typeof window !== "undefined" && window.confirm(message);
  }
}

/**
 * 系统页：左栏系统信息 / 全局配置，右栏版本安装与管理。
 * 不接收 projectDir，也不调用 `vp env current`（即使不传 cwd，vp 也会按进程工作目录
 * 解析 pin），只读取 vpEnvList 与 envPathAudit 两个与目录无关的数据源。
 */
export default function SystemView({
  vpPath,
  notify,
  ensure,
  ensureBusy,
  ensurePhase,
  onRecheck,
  onRepair,
}: Props) {
  // 先用上次成功的快照渲染（避免每次进页面都等 vp 命令），再在后台核对是否有变化
  const cacheKey = vpPath ?? "";
  const [cached] = useState(() => readInstalledCache(cacheKey));
  const [installed, setInstalled] = useState<VpListResult | null>(cached?.installed ?? null);
  const [pathAudit, setPathAudit] = useState<PathAudit | null>(cached?.pathAudit ?? null);
  const [remote, setRemote] = useState<VpRemoteResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(cached?.at ?? null);
  const [envSection, setEnvSection] = useState<"installed" | "remote">("installed");
  const [remoteSelector, setRemoteSelector] = useState("node");
  const [ltsOnly, setLtsOnly] = useState(false);
  const [allRemote, setAllRemote] = useState(false);
  const [perMajor] = useState(3);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [remoteStartedAt, setRemoteStartedAt] = useState<number | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteCachedAt, setRemoteCachedAt] = useState<number | null>(null);
  // 当前 remote 数据对应的筛选组合：与 remoteKey 不一致时说明正在切换工具 / 范围
  const [remoteForKey, setRemoteForKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const resolved = ensure?.path ?? "";
  const version = ensure?.version ?? "";
  const ensureOk = !!ensure?.ok && !!ensure?.compliant;

  /* ------------------------------------------------------------ 数据读取 */

  // 快照存在时视作已加载：短时间内切页不会重复拉取，后台核对只更新有变化的字段
  const loadedKeyRef = useRef(cached ? cacheKey : "");
  const loadedAtRef = useRef(cached?.at ?? 0);
  // 写入快照时的环境变更版本号；变过（例如在项目页安装了版本）就立即重新核对
  const loadedRevRef = useRef(cached?.rev ?? 0);
  const inflightRef = useRef<{ key: string; task: Promise<void> } | null>(null);
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      const key = vpPath ?? "";
      if (
        !force &&
        loadedKeyRef.current === key &&
        loadedRevRef.current === envRevision() &&
        Date.now() - loadedAtRef.current < TTL_LOCAL
      ) {
        return;
      }
      if (!force) {
        const running = inflightRef.current;
        if (running && running.key === key) return running.task;
      }
      const seq = ++refreshSeqRef.current;
      const task = (async () => {
        const [l, a] = await Promise.allSettled([vpEnvList(vpPath), envPathAudit(vpPath)]);
        if (seq !== refreshSeqRef.current) return;
        // 与快照一致时保留原引用，跳过整页重渲染；有变化才替换
        if (l.status === "fulfilled") {
          const next = l.value;
          setInstalled((prev) => (sameSnapshot(prev, next) ? prev : next));
        }
        if (a.status === "fulfilled") {
          const next = a.value;
          setPathAudit((prev) => (sameSnapshot(prev, next) ? prev : next));
        }
        if (l.status === "fulfilled") {
          // PATH 审计失败时沿用上一次的快照，避免把已有审计结果覆盖成空
          const audit = a.status === "fulfilled" ? a.value : readInstalledCache(key)?.pathAudit;
          writeInstalledCache(key, l.value, audit ?? null);
        }
        const failed = [l, a].find((r) => r.status === "rejected");
        setLoadError(failed && failed.status === "rejected" ? errText(failed.reason) : null);
        loadedKeyRef.current = key;
        loadedAtRef.current = Date.now();
        loadedRevRef.current = envRevision();
        setLastLoadedAt(Date.now());
      })();
      inflightRef.current = { key, task };
      try {
        await task;
      } finally {
        if (inflightRef.current?.task === task) inflightRef.current = null;
      }
    },
    [vpPath],
  );

  const remoteSeq = useRef(0);
  const remoteKeyRef = useRef<string | null>(null);
  const remoteFailedKey = useRef<string | null>(null);
  const remoteAtRef = useRef(0);
  const remoteKey = `${remoteSelector}|${ltsOnly ? 1 : 0}|${allRemote ? 1 : 0}`;

  const loadRemote = useCallback(
    async (force = false) => {
      const key = remoteKey;
      if (!force && remoteKeyRef.current === key && Date.now() - remoteAtRef.current < TTL_REMOTE) {
        return;
      }
      if (!force && remoteFailedKey.current === key) return;
      const seq = ++remoteSeq.current;
      setLoadingRemote(true);
      setRemoteError(null);
      setRemoteStartedAt(Date.now());
      try {
        const data = await vpEnvListRemote(vpPath, remoteSelector, ltsOnly, allRemote);
        if (seq !== remoteSeq.current) return;
        setRemote(data);
        setRemoteForKey(key);
        writeRemoteCache(key, data);
        remoteKeyRef.current = key;
        remoteAtRef.current = Date.now();
        remoteFailedKey.current = null;
        setRemoteCachedAt(Date.now());
      } catch (e) {
        if (seq !== remoteSeq.current) return;
        const cached = readRemoteCache(key);
        if (cached) {
          setRemote(cached.data);
          setRemoteCachedAt(cached.at);
        }
        setRemoteForKey(key);
        setRemoteError(errText(e));
        remoteFailedKey.current = key;
      } finally {
        if (seq === remoteSeq.current) {
          setLoadingRemote(false);
          setRemoteStartedAt(null);
        }
      }
    },
    [vpPath, remoteKey, remoteSelector, ltsOnly, allRemote],
  );

  const ops = useVpOps(notify, () => refresh(true));

  useEffect(() => {
    if (ensureOk) void refresh(false);
  }, [ensureOk, refresh]);

  useEffect(() => {
    if (!ensureOk) return;
    const onFocus = () => {
      void refresh(false);
      if (envSection === "remote") void loadRemote(false);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ensureOk, refresh, loadRemote, envSection]);

  useEffect(() => {
    if (ensureOk && envSection === "remote") void loadRemote(false);
  }, [ensureOk, envSection, loadRemote]);

  useEffect(() => {
    if (!ops.busy && !loadingRemote) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ops.busy, loadingRemote]);

  /* ------------------------------------------------------------ 全局操作 */

  const doInstall = async (spec: string): Promise<boolean> => {
    ops.setLastInstallSpec(spec);
    const ok = await ops.runOp(`安装 ${spec}`, () => vpEnvInstall(spec, vpPath, null), summarizeOp);
    if (ok) {
      ops.setLastInstallSpec(null);
      void loadRemote(true);
    }
    if (!ok || !isNodeSpec(spec)) return ok;
    try {
      const list = await vpEnvList(vpPath);
      if ((list.node ?? []).some((i) => i.default)) return true;
      const v = spec.startsWith("node@") ? spec.slice(5) : spec;
      const yes = await confirm(
        `当前尚未设置系统默认 Node 版本。\n\n是否将 ${v} 设为系统默认（vp env default）？所有未固定的目录都会使用它。`,
        "设置系统默认 Node 版本",
      );
      if (yes) await ops.runOp(`设为系统默认 ${v}`, () => vpEnvDefault(v, false, vpPath));
    } catch {
      /* 默认版本检测失败不影响安装结果 */
    }
    return true;
  };

  const doUninstall = async (spec: string) => {
    const ok = await confirm(
      `确定卸载 ${spec} 吗？该版本会被删除，依赖它的项目需要重新固定。`,
      "卸载版本",
    );
    if (!ok) return;
    await ops.runOp(`卸载 ${spec}`, () => vpEnvUninstall(spec, vpPath));
    void loadRemote(true);
  };

  const doSetDefault = (spec: string) =>
    ops.runOp(`设为系统默认 ${spec}`, () => vpEnvDefault(spec, false, vpPath));

  const doUnsetDefault = async () => {
    const ok = await confirm("将清除系统默认版本设置，之后由 Vite+ 自行解析。", "清除系统默认版本");
    if (ok) await ops.runOp("清除系统默认版本", () => vpEnvDefault(null, true, vpPath));
  };

  const doClean = async () => {
    const ok = await confirm(
      "将删除未被项目使用的托管运行时与包管理器缓存。当前使用中与配置为默认的版本会保留，确定继续吗？",
      "清理未使用的安装",
    );
    if (ok) {
      const done = await ops.runOp("清理未使用的安装", () => vpEnvClean(null, vpPath));
      // 清理会删掉未使用的版本，远端列表的「已安装」标记需要一起刷新
      if (done && remote) void loadRemote(true);
    }
  };

  const doRefreshShims = async () => {
    const done = await ops.runOp("刷新 shims", () => vpEnvSetup(true, false), summarizeOp);
    if (done) notify("info", "shims 已刷新", "需新开终端或重启应用，让新的 PATH 生效。");
  };

  const doMode = async (managed: boolean) => {
    const ok = await confirm(
      `将全局切换到${managed ? " Vite+ 托管模式" : "系统优先模式"}。\n\n这会修改 shell 配置，影响之后新开的终端。确定继续吗？`,
      "切换托管模式",
    );
    if (!ok) return;
    const done = await ops.runOp(managed ? "切换到托管模式" : "切换到系统优先", () =>
      vpEnvMode(managed, null, vpPath),
    );
    if (done) notify("info", "托管模式已切换", "需新开终端或重启应用后生效。");
  };

  const cleanAndRetryInstall = async (spec: string) => {
    ops.clearError();
    const ok = await ops.runOp("清理残留安装", () => vpEnvClean(null, vpPath));
    if (ok) await doInstall(spec);
  };

  /* ------------------------------------------------------------ 派生数据 */

  const remoteItems: VpRemoteItem[] = useMemo(() => {
    if (!remote) return [];
    if (remoteSelector === "node") return filterNodeRemote(remote.node ?? []);
    return remote.package_managers?.[remoteSelector] ?? [];
  }, [remote, remoteSelector]);

  const groups = useMemo(
    () => groupByMajor(remoteItems, (i) => i.version, perMajor),
    [remoteItems, perMajor],
  );

  const defaultNodeVersion = installed?.node?.find((n) => n.default)?.version ?? null;
  const defaultPms = ["bun", "pnpm", "npm", "yarn"].flatMap((id) => {
    const item = installed?.package_managers?.[id]?.find((p) => p.default);
    return item ? [`${id} ${displayVersion(item.version)}`] : [];
  });
  const defaultPm = defaultPms.length ? defaultPms.join(" · ") : null;
  const installedNodeCount = installed?.node?.length ?? 0;
  const installedPmCount = ["pnpm", "npm", "yarn", "bun"].reduce(
    (n, id) => n + (installed?.package_managers?.[id]?.length ?? 0),
    0,
  );
  const nodeAudit = pathAudit?.tools.find((t) => t.tool === "node");
  const mode: { label: string; tone: StatusTone } = nodeAudit
    ? {
        label: nodeAudit.managed ? "Vite+ 托管" : "系统优先",
        tone: nodeAudit.managed ? "ok" : "warn",
      }
    : { label: "未读取", tone: "neutral" };
  const shim = shimInfo(pathAudit, mode);
  const vpCopies = pathAudit?.vp_candidates ?? [];
  /** 全局 vp CLI 副本：放到页面上方展示；项目内副本归到项目页 */
  const globalVpPath =
    vpCopies.find((c) => c.scope === "global" && c.primary)?.path ??
    vpCopies.find((c) => c.scope === "global")?.path ??
    resolved;
  const slowRemote =
    loadingRemote && remoteStartedAt !== null && now - remoteStartedAt > REMOTE_SLOW_MS;
  const remoteToolLabel = SELECTORS.find((s) => s.id === remoteSelector)?.label ?? remoteSelector;
  // 已展示的数据与当前筛选不一致 → 正在切换工具 / 版本范围
  const remotePending =
    envSection === "remote" && remoteForKey !== remoteKey && remoteFailedKey.current !== remoteKey;
  const remoteSwitching = remotePending && !!remote;

  const head = (
    <div className="page-head">
      <div className="page-title-row">
        <span className="page-icon">
          <Icon name="layers" size={18} />
        </span>
        <div>
          <h2 className="page-title">系统</h2>
          <p className="page-desc">全局环境与版本管理 · 安装 / 卸载 / 系统默认都作用于整台机器</p>
          <p className="page-desc">
            全局 vp CLI：
            <code className="path-text" title={globalVpPath || undefined}>
              {globalVpPath || "未检测到"}
            </code>
          </p>
        </div>
      </div>
      <div className="page-actions">
        <span className={`status-pill ${ensureOk ? "ok" : ensureBusy ? "busy" : "warn"}`}>
          <span className="status-dot" />
          {ensureBusy ? "检测中" : ensureOk ? "环境就绪" : "需要处理"}
        </span>
        <button className="btn ghost sm" onClick={onRecheck}>
          <Icon name="refresh" size={13} />
          重新检测
        </button>
        <button className="btn ghost sm" onClick={() => void refresh(true)} disabled={!!ops.busy}>
          <Icon name="refresh" size={13} />
          刷新
        </button>
      </div>
    </div>
  );

  if (ensureBusy || !ensure) {
    return (
      <div className="env-view flow-view">
        {head}
        <div className="env-health busy">
          <span className="spinner dark" />
          <div className="env-health-body">
            <div className="env-health-title">正在检查 Vite+ 环境</div>
            <div className="env-health-desc">
              {ensurePhase?.message ?? "正在检测是否已安装、版本是否满足最低要求…"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!ensureOk) {
    return (
      <div className="env-view flow-view">
        {head}
        <OperationFeedback
          tone="warn"
          title="需要补全 Vite+ 运行环境"
          detail={`${ensure.error ?? "启动自检未通过。"}${ensure.log ? `\n\n${ensure.log}` : ""}`}
          note="这是 Vite+ 缺失或版本过低时的可用性修复，只用于让本客户端能够工作。"
          actions={
            <button className="btn primary sm" onClick={onRepair} disabled={ensureBusy}>
              补全运行环境
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
          <p className="hint">升级 Vite+ 请直接在命令行执行 vp upgrade。</p>
        </div>
      </div>
    );
  }

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
            disabled={!!ops.busy || item.default}
            title="vp env default：写入全局默认，所有未固定的目录都会解析到这个版本"
            onClick={() => void doSetDefault(specFor(selector, v, false))}
          >
            设为系统默认
          </button>
          <button
            className="btn sm danger"
            disabled={!!ops.busy}
            onClick={() => void doUninstall(specFor(selector, v, true))}
          >
            卸载
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="env-view system-fixed">
      <div className="system-layout">
        {/* 左栏：系统标题与状态 + 系统信息 + 全局配置 + 维护 */}
        <div className="system-col system-col-left">
          <section className="panel system-head-panel">
            <div className="panel-head">
              <Icon name="layers" size={15} />
              系统
              <span className={`status-pill ${ensureOk ? "ok" : ensureBusy ? "busy" : "warn"}`}>
                <span className="status-dot" />
                {ensureBusy ? "检测中" : ensureOk ? "环境就绪" : "需要处理"}
              </span>
            </div>
            <code className="path-text system-cli-path" title={globalVpPath || undefined}>
              全局 vp CLI · {globalVpPath || "未检测到"}
            </code>
            <div className="system-actions">
              <button className="btn ghost sm" onClick={onRecheck}>
                <Icon name="refresh" size={13} />
                重新检测
              </button>
              <button
                className="btn ghost sm"
                onClick={() => void refresh(true)}
                disabled={!!ops.busy}
              >
                <Icon name="refresh" size={13} />
                刷新
              </button>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">系统信息</div>
            <div className="detail-list">
              <div className="detail-row">
                <span>Vite+ CLI</span>
                <b>{version ? `v${version}` : "未就绪"}</b>
              </div>
              <div className="detail-row">
                <span>托管 / Shim</span>
                <span className="system-info-value">{shim.label}</span>
              </div>
              <div className="detail-row">
                <span>全局默认 Node</span>
                <b>{defaultNodeVersion ? displayVersion(defaultNodeVersion) : "未设置"}</b>
              </div>
              <div className="detail-row">
                <span>默认包管理器</span>
                <span className="ellipsis">{defaultPm ?? "未设置"}</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">全局配置一览</div>
            <div className="detail-list">
              <div className="detail-row">
                <span>shim 目录</span>
                <code className="path-text" title={pathAudit?.shim_dir}>
                  {pathAudit?.shim_dir ?? "—"}
                </code>
              </div>
              <div className="detail-row">
                <span>PATH 首命中</span>
                <code className="path-text" title={nodeAudit?.hits[0]}>
                  {nodeAudit?.hits[0] ?? "未命中"}
                </code>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">工具解析路径</div>
            <div className="detail-list">
              {SELECTORS.map((s) => {
                const t = pathAudit?.tools.find((x) => x.tool === s.id);
                const hit = t?.hits[0] ?? t?.shim_path ?? null;
                return (
                  <div className="detail-row" key={s.id}>
                    <span>{s.label}</span>
                    <code className="path-text" title={hit ?? undefined}>
                      {pathAudit ? (hit ?? "未命中") : "读取中…"}
                    </code>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">托管与维护</div>
            <div className="system-actions">
              <button
                className="btn sm"
                disabled={!!ops.busy}
                onClick={() => void doMode(!mode.label.includes("托管"))}
              >
                {mode.label.includes("托管") ? "关闭托管 (off)" : "开启托管 (on)"}
              </button>
              <button
                className="btn sm"
                disabled={!!ops.busy}
                onClick={() => void doRefreshShims()}
              >
                刷新 shims
              </button>
              <button className="btn sm" disabled={!!ops.busy} onClick={() => void doClean()}>
                清理缓存
              </button>
              <button
                className="btn sm"
                disabled={!!ops.busy}
                onClick={() => void doUnsetDefault()}
              >
                取消系统默认
              </button>
            </div>
            <div className="muted small">
              当前：{mode.label} · {shim.label} · 刷新于 {clock(lastLoadedAt)}
            </div>
          </section>

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
                <button className="btn sm" onClick={() => void refresh(true)} disabled={!!ops.busy}>
                  重试
                </button>
              </div>
            </div>
          ) : null}

          {pathAudit?.warnings.length ? (
            <div className="alert-panel tone-warn" role="alert">
              <span className="alert-icon" aria-hidden="true">
                <Icon name="alert" size={15} />
              </span>
              <div className="alert-body">
                <div className="alert-title">
                  PATH / shim 审计发现 {pathAudit.warnings.length} 项
                </div>
                <div className="alert-desc">{pathAudit.warnings.join("；")}</div>
              </div>
              <div className="alert-actions">
                <button
                  className="btn sm"
                  onClick={() => void doRefreshShims()}
                  disabled={!!ops.busy}
                >
                  刷新 shims
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 右栏：版本安装与管理（含操作进度、反馈与输出），占满整个右侧 */}
        <div className="system-col system-col-right">
          {ops.busy ? (
            <OperationProgress
              label={ops.busy}
              startedAt={ops.busySince}
              cancelled={ops.opCancelled}
              stage={ops.installStage}
              onCancel={() => void ops.cancelOp()}
            />
          ) : null}

          {ops.opError && !ops.busy ? (
            <OperationFeedback
              tone="error"
              title={`操作失败：${ops.opError.label}`}
              detail={ops.opError.message}
              note={`失败分类：${ops.failureInfo?.label ?? "未知失败"}。${ops.failureInfo?.tip ?? ""}`}
              actions={
                <>
                  <button className="btn sm" onClick={() => void ops.retry()}>
                    重试
                  </button>
                  {ops.lastInstallSpec ? (
                    <button
                      className="btn sm"
                      onClick={() => void cleanAndRetryInstall(ops.lastInstallSpec!)}
                    >
                      清理残留并重试
                    </button>
                  ) : null}
                </>
              }
              onClose={ops.clearError}
            />
          ) : null}

          {ops.opResult && !ops.busy ? (
            <OperationFeedback
              tone="success"
              title={`已完成：${ops.opResult.label}`}
              detail={ops.opResult.text || "命令执行成功（无输出）"}
              onClose={ops.clearResult}
            />
          ) : null}

          <section className="panel system-version-panel">
            <div className="panel-head">
              版本安装与管理
              <span className="tag plain">作用范围：整台机器</span>
            </div>

            <div className="segmented" role="tablist" aria-label="版本视图">
              <button
                role="tab"
                aria-selected={envSection === "installed"}
                className={envSection === "installed" ? "active" : ""}
                onClick={() => setEnvSection("installed")}
              >
                已安装（{installedNodeCount + installedPmCount}）
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

            {envSection === "remote" ? (
              <div className="toolbar compact">
                <select
                  className="select"
                  style={{ width: 116 }}
                  value={remoteSelector}
                  onChange={(e) => {
                    setRemoteSelector(e.target.value);
                    remoteFailedKey.current = null;
                    remoteKeyRef.current = null;
                    if (e.target.value !== "node") setLtsOnly(false);
                  }}
                >
                  {SELECTORS.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {remoteSelector === "node" ? (
                  <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={ltsOnly}
                      onChange={(e) => {
                        setLtsOnly(e.target.checked);
                        remoteKeyRef.current = null;
                      }}
                    />
                    仅 LTS
                  </label>
                ) : null}
                <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={allRemote}
                    onChange={(e) => {
                      setAllRemote(e.target.checked);
                      remoteKeyRef.current = null;
                    }}
                  />
                  全部历史版本
                </label>
                <div className="spacer" />
                <button
                  className="btn ghost sm"
                  onClick={() => void loadRemote(true)}
                  disabled={loadingRemote}
                >
                  <Icon name="refresh" size={12} />
                  刷新
                </button>
              </div>
            ) : null}

            {remoteSwitching ? (
              <div className="load-strip" role="status" aria-live="polite">
                <span className="spinner dark" />
                <span>
                  {slowRemote
                    ? `远端响应较慢，仍在获取 ${remoteToolLabel} 版本列表…`
                    : `正在获取 ${remoteToolLabel} 版本列表…`}
                </span>
                <span className="load-strip-note">
                  {allRemote ? "包含全部历史版本" : "仅稳定版本"}
                </span>
              </div>
            ) : null}

            {remoteError ? (
              <div className="inline-warn danger">
                远端版本获取失败：{remoteError}
                {remoteCachedAt ? ` · 正在显示 ${clock(remoteCachedAt)} 的本地缓存` : ""}
              </div>
            ) : null}
            {slowRemote && !remoteSwitching ? (
              <div className="hint">远端请求较慢，仍在等待 vp env list-remote…</div>
            ) : null}

            <div className={`list-scroll${remoteSwitching ? " is-loading" : ""}`}>
              {envSection === "installed" ? (
                !installed && !loadError ? (
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
                )
              ) : loadingRemote && !remote ? (
                <SkeletonRows rows={6} />
              ) : (
                <>
                  {groups.map((g) => (
                    <div className="major-group" key={g.major}>
                      <div className="major-head">
                        <span className="major-title">v{g.major}.x</span>
                        <span className="major-bar" />
                        <span className="major-count">{g.items.length} 个</span>
                      </div>
                      <div className="list">
                        {g.items.map((i) => {
                          const spec = specFor(
                            remoteSelector,
                            displayVersion(i.version),
                            remoteSelector === "node",
                          );
                          return (
                            <div className="list-row" key={`${remoteSelector}-${i.version}`}>
                              <span className="v">{displayVersion(i.version)}</span>
                              {i.lts ? <span className="tag plain">LTS {i.lts}</span> : null}
                              {i.latest ? <span className="tag accent">最新</span> : null}
                              {i.installed ? <span className="tag ok">已安装</span> : null}
                              <div className="row-actions">
                                {i.installed ? null : (
                                  <button
                                    className="btn sm"
                                    disabled={!!ops.busy}
                                    onClick={() => void doInstall(spec)}
                                  >
                                    安装
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {!loadingRemote && groups.length === 0 && !remoteError ? (
                    <div className="hint">没有可显示的版本，试试勾选「全部历史版本」或刷新。</div>
                  ) : null}
                </>
              )}
            </div>

            <div className="version-foot">
              <span>
                {envSection === "installed"
                  ? `已安装 ${installedNodeCount + installedPmCount} 个版本`
                  : `当前显示 ${remoteItems.length} 个可安装版本`}
              </span>
              <span>
                {envSection === "installed"
                  ? `刷新于 ${clock(lastLoadedAt)}`
                  : remoteCachedAt
                    ? `数据时间 ${clock(remoteCachedAt)}`
                    : "来源：vp env list-remote"}
              </span>
            </div>
          </section>

          <ConsolePanel
            text={ops.consoleText}
            source={ops.consoleSource}
            at={ops.consoleAt}
            onClear={ops.clearConsole}
          />
        </div>
      </div>
    </div>
  );
}
