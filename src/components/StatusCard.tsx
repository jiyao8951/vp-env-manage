import Icon, { type IconName } from "./Icon";

export type StatusTone = "ok" | "warn" | "danger" | "info" | "neutral";

interface Props {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: StatusTone;
  icon?: IconName;
  actions?: React.ReactNode;
  /** 悬停说明，用于放不下的完整路径等 */
  hint?: string;
}

/**
 * 显性状态卡：把「托管模式 / shim / 数据时间 / 多副本提示」这类
 * 原本藏在日志里的信息放到页面顶部。只做展示，不承担操作逻辑。
 */
export default function StatusCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  actions,
  hint,
}: Props) {
  return (
    <div className={`status-card tone-${tone}`} title={hint}>
      <div className="status-card-head">
        {icon ? (
          <span className="status-card-icon">
            <Icon name={icon} size={15} />
          </span>
        ) : null}
        <span className="status-card-label">{label}</span>
        <span className={`status-card-dot tone-${tone}`} aria-hidden="true" />
      </div>
      <div className="status-card-value">{value}</div>
      {sub ? <div className="status-card-sub">{sub}</div> : null}
      {actions ? <div className="status-card-actions">{actions}</div> : null}
    </div>
  );
}
