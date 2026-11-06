import { useEffect, useState } from "react";
import Icon from "./Icon";

type Tone = "error" | "success" | "warn";

interface FeedbackProps {
  tone: Tone;
  title: string;
  /** 原始输出 / 错误文本，失败时完整保留，方便复制排查 */
  detail?: string;
  note?: string;
  actions?: React.ReactNode;
  onClose?: () => void;
}

/** 固定的操作结果位：成功 / 失败都在同一位置展示，失败保留原文 */
export function OperationFeedback({ tone, title, detail, note, actions, onClose }: FeedbackProps) {
  return (
    <div className={`op-feedback tone-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="op-feedback-head">
        <span className="op-feedback-icon" aria-hidden="true">
          <Icon
            name={tone === "error" ? "alert" : tone === "success" ? "check" : "info"}
            size={15}
          />
        </span>
        <span className="op-feedback-title">{title}</span>
        <div className="op-feedback-actions">
          {actions}
          {onClose ? (
            <button className="btn ghost sm" onClick={onClose}>
              <Icon name="x" size={12} />
              关闭
            </button>
          ) : null}
        </div>
      </div>
      {detail ? <pre className="op-feedback-pre">{detail}</pre> : null}
      {note ? <div className="op-feedback-note">{note}</div> : null}
    </div>
  );
}

interface ProgressProps {
  label: string;
  startedAt: number | null;
  onCancel?: () => void;
  cancelled?: boolean;
  /** 安装阶段（下载 / 解压 / 校验），由后端输出实时推断 */
  stage?: { phase: string; message: string } | null;
}

const PHASE_LABELS: Record<string, string> = {
  resolve: "解析依赖",
  download: "下载",
  extract: "解压",
  verify: "校验",
  install: "安装",
  done: "完成",
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 长操作进度：显示已耗时与阶段，并提供「取消」（会终止进程树）入口 */
export function OperationProgress({ label, startedAt, onCancel, cancelled, stage }: ProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - startedAt);
    const t = window.setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);

  return (
    <div className="op-progress" role="status" aria-live="polite">
      <span className="spinner dark" aria-hidden="true" />
      <div className="op-progress-body">
        <div className="op-progress-title">
          正在执行：{label}
          <span className="op-progress-elapsed" title="已耗时">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div className="op-progress-desc">
          {cancelled
            ? "正在终止进程树并确认退出；结束后会如实反馈是否有残留，并自动刷新状态。"
            : stage
              ? `${PHASE_LABELS[stage.phase] ?? stage.phase}：${stage.message || "进行中"}`
              : "安装 / 清理可能需要几分钟，请勿重复点击。"}
        </div>
        <div className="op-progress-track" aria-hidden="true">
          <span />
        </div>
      </div>
      {onCancel ? (
        <button className="btn sm danger" onClick={onCancel} disabled={cancelled}>
          {cancelled ? "正在取消…" : "取消"}
        </button>
      ) : null}
    </div>
  );
}
