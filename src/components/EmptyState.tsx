import Icon, { type IconName } from "./Icon";

interface Props {
  title: string;
  desc?: React.ReactNode;
  icon?: IconName;
  actions?: React.ReactNode;
  /** 紧凑模式用于列表内空态 */
  compact?: boolean;
}

export default function EmptyState({ title, desc, icon = "info", actions, compact }: Props) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 18 : 24} />
      </span>
      <div className="empty-state-title">{title}</div>
      {desc ? <div className="empty-state-desc">{desc}</div> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  );
}
