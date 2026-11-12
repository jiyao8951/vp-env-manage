import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  envPathAudit,
  errText,
  pickProjectDir,
  pinBackup,
  pinInspect,
  pinPreview,
  vpEnvCurrent,
  vpEnvInstall,
  vpEnvList,
  vpEnvPin,
  vpEnvUnpin,
  vpInstallProject,
  type PathAudit,
  type PinChange,
  type PinReport,
  type VpCandidate,
  type VpCurrentResult,
  type VpListResult,
} from "../lib/api";
import { displayVersion } from "../lib/version";
import {
  PIN_TARGETS,
  REVALIDATE_MS,
  SELECTORS,
  SkeletonRows,
  TONE_ICON,
  TTL_LOCAL,
  envRevision,
  modeInfo,
  pathInside,
  readInstalledCache,
  readProjectCache,
  sameSnapshot,
  specFor,
  useVpOps,
  writeProjectCache,
  type Notify,
} from "../lib/envShared";
import Icon from "./Icon";
import { OperationFeedback, OperationProgress } from "./OperationFeedback";
import StatusCard from "./StatusCard";

interface Props {
  vpPath: string | null;
  /** 当前所选项目：本页所有查询与写入都限定在这个目录 */
  projectDir: string | null;
  onProjectDirChange: (dir: string) => void;
  notify: Notify;
}

async function confirm(message: string, title: string): Promise<boolean> {
  try {
    return await ask(message, { title, kind: "warning" });
  } catch {
    return typeof window !== "undefined" && window.confirm(message);
  }
}

/** 把预览结果压成确认框里的一句话，避免再单独做一步「变更预览 + 确认写入」 */
function describeChanges(changes: PinChange[]): string {
  if (!changes.length) return "未检测到需要变更的文件";
  const label: Record<string, string> = {
    create: "新建",
    update: "修改",
    remove: "移除",
    unchanged: "无变化",
  };
  return changes.map((c) => `${label[c.action] ?? c.action} ${c.path}`).join("\n");
}

/**
 * 项目页：版本清单只来自系统已安装列表（vp env list）。
 * 流程是「先在系统页装好版本 → 再到这里固定到项目」，所以不提供可安装版本列表。
 * 写操作全部走 quiet 模式：成功只弹一个短 toast，不产生页面内反馈条或控制台。
 */
export default function ProjectView({ vpPath, projectDir, onProjectDirChange, notify }: Props) {
  const hasDir = !!projectDir && !!projectDir.trim();
  const cacheKey = `${vpPath ?? ""}|${projectDir ?? ""}`;
  // 先用该项目上次成功的快照渲染（避免每次进页面都等三条命令），再在后台核对
  const [cached] = useState(() => (hasDir ? readProjectCache(cacheKey) : null));
  const [current, setCurrent] = useState<VpCurrentResult | null>(cached?.current ?? null);
  const [pinReport, setPinReport] = useState<PinReport | null>(cached?.pinReport ?? null);
  // 版本清单是系统级数据，项目页没有快照时先借系统页的缓存，避免左侧整块骨架屏
  const [installed, setInstalled] = useState<VpListResult | null>(
    cached?.installed ?? readInstalledCache(vpPath ?? "")?.installed ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectCopies, setProjectCopies] = useState<VpCandidate[]>([]);
  const [pinTarget, setPinTarget] = useState("");
  const [unpinScope, setUnpinScope] = useState("");
  const [unpinTarget, setUnpinTarget] = useState("");

  // 快照存在时视作已加载：短时间内切页不会重复拉取，后台核对只更新有变化的字段
  const loadedKeyRef = useRef(cached ? cacheKey : "");
  const loadedAtRef = useRef(cached?.at ?? 0);
  // 快照写入时的环境变更版本号；变过（例如刚在系统页装了新版本）就立即重新核对
  const loadedRevRef = useRef(cached?.rev ?? 0);
  const dataKeyRef = useRef(cacheKey);
  const refreshSeqRef = useRef(0);

  /** 项目刷新：带 cwd 的 current + pin 解析 + 系统已安装清单；失败沿用旧值 */
  const refresh = useCallback(
    async (force = false) => {
      const key = `${vpPath ?? ""}|${projectDir ?? ""}`;
      if (
        !force &&
        loadedKeyRef.current === key &&
        loadedRevRef.current === envRevision() &&
        Date.now() - loadedAtRef.current < REVALIDATE_MS
      ) {
        return;
      }
      const seq = ++refreshSeqRef.current;
      if (!projectDir || !projectDir.trim()) {
        if (seq === refreshSeqRef.current) {
          setCurrent(null);
          setPinReport(null);
          setInstalled(null);
          setLoadError(null);
          loadedKeyRef.current = key;
          loadedAtRef.current = Date.now();
        }
        return;
      }
      const [c, p, l] = await Promise.allSettled([
        vpEnvCurrent(vpPath, projectDir),
        pinInspect(projectDir),
        vpEnvList(vpPath),
      ]);
      if (seq !== refreshSeqRef.current) return;
      // 与快照一致时保留原引用，跳过整页重渲染；有变化才替换
      if (c.status === "fulfilled") {
        const next = c.value;
        setCurrent((prev) => (sameSnapshot(prev, next) ? prev : next));
      }
      if (p.status === "fulfilled") {
        const next = p.value;
        setPinReport((prev) => (sameSnapshot(prev, next) ? prev : next));
      }
      if (l.status === "fulfilled") {
        const next = l.value;
        setInstalled((prev) => (sameSnapshot(prev, next) ? prev : next));
      }
      // 失败项沿用上一次快照，避免把已经取到的内容覆盖成空
      const prevSnap = readProjectCache(key);
      writeProjectCache(key, {
        current: c.status === "fulfilled" ? c.value : (prevSnap?.current ?? null),
        pinReport: p.status === "fulfilled" ? p.value : (prevSnap?.pinReport ?? null),
        installed: l.status === "fulfilled" ? l.value : (prevSnap?.installed ?? null),
      });
      const failed = [c, p, l].find((r) => r.status === "rejected");
      setLoadError(failed && failed.status === "rejected" ? errText(failed.reason) : null);
      loadedKeyRef.current = key;
      loadedAtRef.current = Date.now();
      loadedRevRef.current = envRevision();
    },
    [vpPath, projectDir],
  );

  const ops = useVpOps(notify, () => refresh(true));

  // 切换项目时先切到该项目自己的快照，避免沿用上一个项目的数据
  useEffect(() => {
    if (dataKeyRef.current === cacheKey) return;
    dataKeyRef.current = cacheKey;
    const snap = hasDir ? readProjectCache(cacheKey) : null;
    setCurrent(snap?.current ?? null);
    setPinReport(snap?.pinReport ?? null);
    setInstalled(snap?.installed ?? readInstalledCache(vpPath ?? "")?.installed ?? null);
    setLoadError(null);
    loadedKeyRef.current = snap ? cacheKey : "";
    loadedAtRef.current = snap?.at ?? 0;
    loadedRevRef.current = snap?.rev ?? 0;
  }, [cacheKey, hasDir]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // 窗口重新获得焦点通常意味着用户刚在终端 / 编辑器里动过环境或 pin，
  // 这里只压掉 2 秒内的重复触发，不受 30 秒快照窗口限制
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - loadedAtRef.current < TTL_LOCAL) return;
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  /** 项目内 vp CLI 副本：优先复用系统页缓存的 PATH 审计，避免每次进页面都重跑 vp --version */
  useEffect(() => {
    let alive = true;
    const applyAudit = (audit: PathAudit | null) => {
      if (!alive) return;
      setProjectCopies(
        (audit?.vp_candidates ?? []).filter(
          (c) =>
            c.scope === "project" &&
            (!c.project || !projectDir || pathInside(projectDir, c.project)),
        ),
      );
    };
    const cachedAudit = readInstalledCache(vpPath ?? "")?.pathAudit ?? null;
    applyAudit(cachedAudit);
    if (!cachedAudit)
      void envPathAudit(vpPath)
        .then(applyAudit)
        .catch(() => applyAudit(null));
    return () => {
      alive = false;
    };
  }, [vpPath, projectDir]);

  const needDir = (): boolean => {
    if (hasDir) return true;
    notify("error", "请先选择项目目录");
    return false;
  };

  const pickDir = async () => {
    try {
      const dir = await pickProjectDir(projectDir);
      if (dir) onProjectDirChange(dir);
    } catch (e) {
      notify("error", "选择目录失败", errText(e));
    }
  };

  /* ------------------------------------------------------------ 版本操作 */

  /** 点版本行「固定到项目」：预览只用于生成确认文案与备份清单，不再多一步 UI */
  const doPinVersion = async (spec: string) => {
    if (!needDir()) return;
    try {
      const changes = await pinPreview(projectDir!, [spec], pinTarget || null, false);
      const outside = changes.some((c) => !pathInside(projectDir!, c.path));
      const ok = await confirm(
        `将把 ${spec} 固定到当前项目：\n${projectDir}\n\n${describeChanges(changes)}${
          outside
            ? "\n\n注意：有文件位于项目目录之外（上层 workspace 根），会影响该目录下的其它项目。"
            : ""
        }\n\n执行前会自动备份将被修改的文件。`,
        "固定到当前项目",
      );
      if (!ok) return;
      const changed = changes.filter((c) => c.action !== "unchanged");
      if (changed.length) {
        // 备份静默执行，不再单独弹提示
        await pinBackup(changed.map((c) => c.path));
      }
      const done = await ops.runOp(
        `固定 ${spec} 到项目`,
        () => vpEnvPin(projectDir!, [spec], vpPath, pinTarget || null, false, false),
        undefined,
        true,
      );
      if (done) void refresh(true);
    } catch (e) {
      notify("error", "固定到项目失败", errText(e));
    }
  };

  const doUnpin = async () => {
    if (!needDir()) return;
    const previewSpecs =
      unpinScope === ""
        ? ["node@0", "pnpm@0", "npm@0", "yarn@0", "bun@0"]
        : unpinScope === "pm"
          ? ["pnpm@0", "npm@0", "yarn@0", "bun@0"]
          : [`${unpinScope}@0`];
    const ok = await confirm(
      `将取消当前项目的固定（${unpinScope || "全部"}）：\n${projectDir}\n\n执行前会自动备份被修改的文件。`,
      "取消项目固定",
    );
    if (!ok) return;
    try {
      const changes = await pinPreview(projectDir!, previewSpecs, unpinTarget || null, true);
      const changed = changes.filter((c) => c.action !== "unchanged");
      if (changed.length) await pinBackup(changed.map((c) => c.path));
    } catch {
      /* 预览失败不阻断 unpin，实际写入以 vp 输出为准 */
    }
    await ops.runOp(
      "取消项目固定",
      () => vpEnvUnpin(projectDir!, unpinScope || null, vpPath, unpinTarget || null),
      undefined,
      true,
    );
  };

  const doInstallProjectEnv = async () => {
    if (!needDir()) return;
    const ok = await confirm(
      `将按此项目的固定配置安装完整的 Node.js 与包管理器环境：\n${projectDir}`,
      "安装项目环境",
    );
    if (ok) {
      await ops.runOp(
        "安装项目环境",
        () => vpEnvInstall(null, vpPath, projectDir),
        undefined,
        true,
      );
    }
  };

  const doInstallProjectDeps = async () => {
    if (!needDir()) return;
    const ok = await confirm(
      `将在此项目目录执行 vp install（安装 package.json 依赖）：\n${projectDir}\n\n` +
        `这不会安装 Node.js / 包管理器；需要它们时请用「安装项目环境」。`,
      "安装项目依赖",
    );
    if (ok) {
      await ops.runOp("安装项目依赖", () => vpInstallProject(projectDir!, vpPath), undefined, true);
    }
  };

  /* ------------------------------------------------------------ 派生数据 */

  const mode = modeInfo(current?.node?.mode ?? current?.package_manager?.mode);
  const nodeMissing = current?.node?.installed === false;
  const effectivePins = pinReport?.entries?.filter((e) => e.effective) ?? [];

  /** 当前项目已经解析到这个版本时，不再显示「固定到项目」按钮 */
  const pinnedNode = current?.node?.version ? displayVersion(current.node.version) : null;
  const pmName = current?.package_manager?.name?.toLowerCase() ?? null;
  const pinnedPm = current?.package_manager?.version
    ? displayVersion(current.package_manager.version)
    : null;
  const usedByProject = (selector: string, v: string): boolean =>
    selector === "node" ? pinnedNode === v : selector === pmName && pinnedPm === v;

  const head = (
    <div className="page-head">
      <div className="page-title-row">
        <span className="page-icon">
          <Icon name="pin" size={18} />
        </span>
        <div>
          <h2 className="page-title">项目</h2>
          <p className="page-desc">先在「系统」页装好版本，再在这里固定到当前项目</p>
        </div>
      </div>
      <div className="page-actions">
        <button
          className="btn ghost sm"
          onClick={() => void refresh(true)}
          disabled={!!ops.busy || !hasDir}
        >
          <Icon name="refresh" size={13} />
          刷新
        </button>
      </div>
    </div>
  );

  return (
    <div className="env-view project-fixed">
      {head}

      {/* 项目路径常驻展示：所有信息都明确归属这个目录 */}
      <section className="panel project-bar">
        <span className="project-icon">
          <Icon name="folder" size={16} />
        </span>
        <div className="project-main">
          <span className="project-label">当前项目</span>
          {hasDir ? (
            <code className="project-path path-text" title={projectDir ?? undefined}>
              {projectDir}
            </code>
          ) : (
            <span className="project-text muted">尚未选择项目目录</span>
          )}
        </div>
        <button className="btn sm" onClick={() => void pickDir()}>
          {hasDir ? "更换目录" : "选择目录"}
        </button>
      </section>

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
            <button className="btn sm" onClick={() => void ops.retry()}>
              重试
            </button>
          }
          onClose={ops.clearError}
        />
      ) : null}

      {!hasDir ? (
        <div className="card" style={{ padding: 24 }}>
          <div className="empty-state">
            <span className="empty-state-icon">
              <Icon name="folder" size={22} />
            </span>
            <div className="empty-state-title">先选择一个项目目录</div>
            <div className="empty-state-desc">
              本页只展示并修改所选项目的环境：解析 pin、固定版本、安装项目环境或依赖。
            </div>
            <div className="empty-state-actions">
              <button className="btn primary sm" onClick={() => void pickDir()}>
                选择项目目录
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="status-cards">
            <StatusCard
              label="当前项目 Node"
              icon={nodeMissing ? "alert" : TONE_ICON.ok}
              tone={nodeMissing ? "warn" : current?.node?.version ? "ok" : "neutral"}
              value={current?.node?.version ? displayVersion(current.node.version) : "—"}
              sub={nodeMissing ? "该版本尚未安装" : `来源：${current?.node?.source ?? "—"}`}
              hint={current?.node?.source_path}
            />
            <StatusCard
              label="生效 pin"
              icon="pin"
              tone={effectivePins.length ? "ok" : "neutral"}
              value={`${effectivePins.length} 条`}
              sub={effectivePins.length ? "项目或其上层目录的固定" : "未固定，使用全局默认"}
            />
            <StatusCard
              label="包管理器"
              icon="sliders"
              tone={current?.package_manager?.version ? "ok" : "neutral"}
              value={
                current?.package_manager
                  ? `${current.package_manager.name ?? "—"} ${current.package_manager.version ?? ""}`.trim()
                  : "—"
              }
              sub={`来源：${current?.package_manager?.source ?? "—"}`}
            />
            <StatusCard
              label="托管模式"
              icon="layers"
              tone={mode.tone}
              value={mode.label}
              sub={`项目根：${current?.node?.project_root ?? current?.package_manager?.project_root ?? "—"}`}
            />
          </div>

          <div className="page-split">
            {/* 左栏：只列系统已安装版本，点按钮固定到当前项目 */}
            <div className="split-col split-main">
              <section className="panel project-version-panel">
                <div className="panel-head">
                  系统已安装版本
                  <span className="tag plain">操作仅作用于当前项目</span>
                </div>

                <div className="toolbar compact">
                  <span className="muted small">写入目标</span>
                  <select
                    className="select"
                    style={{ width: 150 }}
                    value={pinTarget}
                    onChange={(e) => setPinTarget(e.target.value)}
                    title="点「固定到项目」时写入哪个文件 / 字段；自动时由 Vite+ 判断"
                  >
                    {PIN_TARGETS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">需要新版本请先到「系统」页安装</span>
                </div>

                {loadError ? (
                  <div className="inline-warn danger">项目环境读取失败：{loadError}</div>
                ) : null}

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
                              items.map((i) => {
                                const v = displayVersion(i.version);
                                const already = usedByProject(s.id, v);
                                return (
                                  <div className="list-row" key={`${s.id}-${v}`}>
                                    <span className="v">{v}</span>
                                    {i.default ? <span className="tag ok">系统默认</span> : null}
                                    {already ? (
                                      <span className="tag accent">当前项目在用</span>
                                    ) : null}
                                    <div className="row-actions">
                                      {already ? null : (
                                        <button
                                          className="btn sm primary"
                                          disabled={!!ops.busy}
                                          title="把该版本写入当前项目的 pin 文件"
                                          onClick={() => void doPinVersion(specFor(s.id, v, true))}
                                        >
                                          固定到项目
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <div className="list-row">
                                <span className="muted small">系统未安装该工具的版本</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="version-foot">
                  <span>
                    {installed ? (
                      <>
                        系统已安装{" "}
                        {(installed.node?.length ?? 0) +
                          ["pnpm", "npm", "yarn", "bun"].reduce(
                            (n, id) => n + (installed.package_managers?.[id]?.length ?? 0),
                            0,
                          )}{" "}
                        个版本
                      </>
                    ) : (
                      "正在读取已安装版本…"
                    )}
                  </span>
                  <span>{pinReport ? `生效固定 ${effectivePins.length} 项` : "正在读取固定…"}</span>
                </div>
              </section>
            </div>

            {/* 右栏：项目现状与次要操作 */}
            <aside className="split-col split-side">
              <section className="panel">
                <div className="panel-head">当前项目环境</div>
                <div className="detail-list">
                  <div className="detail-row">
                    <span>Node</span>
                    <b>{current?.node?.version ? displayVersion(current.node.version) : "—"}</b>
                  </div>
                  <div className="detail-row">
                    <span>来源</span>
                    <span className="ellipsis" title={current?.node?.source_path}>
                      {current?.node?.source ?? "—"}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span>状态</span>
                    <span>{nodeMissing ? "版本未安装" : "已安装"}</span>
                  </div>
                  <div className="detail-row">
                    <span>包管理器</span>
                    <span className="ellipsis">
                      {current?.package_manager
                        ? `${current.package_manager.name ?? "—"} ${current.package_manager.version ?? ""}`
                        : "—"}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span>项目根</span>
                    <code className="path-text" title={current?.node?.project_root}>
                      {current?.node?.project_root ?? "—"}
                    </code>
                  </div>
                </div>
                {!current && !pinReport && !loadError ? <SkeletonRows rows={3} /> : null}
              </section>

              <section className="panel">
                <div className="panel-head">生效的版本固定</div>
                <div className="detail-list">
                  {effectivePins.length ? (
                    effectivePins.map((e) => (
                      <div className="detail-row" key={`${e.path}-${e.kind}`}>
                        <span>{e.key}</span>
                        <span className="ellipsis" title={`${e.kind} @ ${e.path}`}>
                          <b>{e.value}</b>
                          <span className="muted small"> · {e.file}</span>
                          {e.depth > 0 ? <span className="tag warn">上层目录</span> : null}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="detail-row">
                      <span>—</span>
                      <span className="muted">
                        未发现 pin 文件，vp 会沿上层查找或使用全局默认。
                      </span>
                    </div>
                  )}
                </div>
                {nodeMissing ? (
                  <div className="inline-warn danger">
                    项目固定到 {displayVersion(current?.node?.version ?? "")}，但该版本尚未安装。
                    请先到「系统」页安装该版本。
                  </div>
                ) : null}
                {pinReport?.conflicts.length ? (
                  <div className="inline-warn danger">
                    固定冲突：
                    {pinReport.conflicts
                      .map((c) => `${c.key} = ${c.values.join(" / ")}（${c.dir}）`)
                      .join("；")}
                  </div>
                ) : null}
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
                    <option value="">范围：全部</option>
                    <option value="node">范围：node</option>
                    <option value="pm">范围：包管理器</option>
                    <option value="pnpm">范围：pnpm</option>
                    <option value="npm">范围：npm</option>
                    <option value="yarn">范围：yarn</option>
                    <option value="bun">范围：bun</option>
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
                    disabled={!!ops.busy}
                    onClick={() => void doUnpin()}
                  >
                    <Icon name="x" size={13} />
                    取消固定
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">安装到当前项目</div>
                <div className="panel-actions">
                  <button
                    className="btn sm"
                    disabled={!!ops.busy}
                    onClick={() => void doInstallProjectEnv()}
                    title="vp env install：按项目的 pin / packageManager 一次性装齐 Node.js 与包管理器"
                  >
                    <Icon name="download" size={13} />
                    安装项目环境
                  </button>
                  <button
                    className="btn sm"
                    disabled={!!ops.busy}
                    onClick={() => void doInstallProjectDeps()}
                    title="vp install：按 package.json 安装依赖，不改 Node / 包管理器版本"
                  >
                    <Icon name="package" size={13} />
                    安装项目依赖
                  </button>
                </div>
                <div className="hint">
                  按项目固定装齐环境，或安装 package.json 依赖；新版本请先在「系统」页安装。
                </div>
              </section>

              {projectCopies.length ? (
                <section className="panel">
                  <div className="panel-head">项目内 vp CLI 副本</div>
                  <div className="detail-list">
                    {projectCopies.map((c) => (
                      <div className="detail-row" key={c.path}>
                        <span>{c.version ? `v${c.version}` : "副本"}</span>
                        <code className="path-text" title={c.path}>
                          {c.path}
                        </code>
                      </div>
                    ))}
                  </div>
                  <div className="hint">位于项目依赖中，不属于全局 CLI。</div>
                </section>
              ) : null}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
