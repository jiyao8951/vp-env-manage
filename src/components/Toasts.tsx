import Icon, { type IconName } from "./Icon";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  text?: string;
}

const ICONS: Record<ToastKind, IconName> = {
  info: "info",
  success: "check",
  error: "alert",
};

export default function Toasts({
  toasts,
  onClose,
}: {
  toasts: Toast[];
  onClose: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}`}
          onClick={() => onClose(t.id)}
          role="alert"
          title="点击关闭"
        >
          <span className="toast-icon" aria-hidden="true">
            <Icon name={ICONS[t.kind]} size={13} />
          </span>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.text ? <div className="toast-text">{t.text}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
