import { useRef } from "react";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import LogoMark from "./Logo";

const win = getCurrentWindow();

function Icon({ d, size = 10 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth={1} fill="none" strokeLinecap="round" />
    </svg>
  );
}

interface Props {
  subtitle?: string;
  /** 窗口是否置顶 */
  alwaysOnTop?: boolean;
  onToggleAlwaysOnTop?: () => void;
}

export default function TitleBar({ subtitle, alwaysOnTop, onToggleAlwaysOnTop }: Props) {
  /* 自定义拖拽：不用 data-tauri-drag-region，避免拖到屏幕边缘时触发
     Windows Aero Snap 贴边分屏/最大化（窗口固定尺寸，分屏没有意义） */
  const drag = useRef<{ dx: number; dy: number; ready: boolean; raf: number } | null>(null);

  const onDragStart = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || drag.current) return;
    // React 合成事件派发完后 currentTarget 会被置空，必须先同步取出；
    // drag.current 也必须同步置位，否则快速点击时 pointerup 可能先于
    // 异步准备完成，导致本次拖拽丢失
    const el = e.currentTarget;
    const pid = e.pointerId;
    const sx = e.screenX;
    const sy = e.screenY;
    drag.current = { dx: 0, dy: 0, ready: false, raf: 0 };
    void (async () => {
      try {
        const sf = await win.scaleFactor();
        const pos = await win.outerPosition();
        if (drag.current) {
          drag.current.dx = sx - pos.x / sf;
          drag.current.dy = sy - pos.y / sf;
          drag.current.ready = true;
          el.setPointerCapture(pid);
        }
      } catch {
        /* 忽略 */
      }
    })();
  };

  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !d.ready || d.raf) return;
    const x = e.screenX - d.dx;
    const y = e.screenY - d.dy;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      void win.setPosition(new LogicalPosition(x, y)).catch(() => undefined);
    });
  };

  const onDragEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    if (drag.current.raf) cancelAnimationFrame(drag.current.raf);
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div className="titlebar">
      <div
        className="tb-left"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="tb-logo">
          <LogoMark size={22} />
        </div>
        <span className="tb-title">FlowDeck</span>
        {subtitle ? (
          <>
            <span className="tb-sep" aria-hidden="true" />
            <span className="tb-sub">{subtitle}</span>
          </>
        ) : null}
      </div>

      <div className="tb-actions">
        {onToggleAlwaysOnTop ? (
          <button
            className={`tb-btn ${alwaysOnTop ? "on" : ""}`}
            title={alwaysOnTop ? "取消置顶" : "窗口置顶"}
            aria-label={alwaysOnTop ? "取消置顶" : "窗口置顶"}
            aria-pressed={!!alwaysOnTop}
            onClick={onToggleAlwaysOnTop}
          >
            <Icon d="M2.1 2.1 H7.9 M5 2.1 V8.3 M3.3 4.1 L5 2.1 L6.7 4.1" size={10} />
          </button>
        ) : null}
        <button
          className="tb-btn"
          title="最小化"
          onClick={() => void win.minimize()}
          aria-label="最小化"
        >
          <Icon d="M0.8 5 H9.2" size={10} />
        </button>
        <button
          className="tb-btn close"
          title="退出 FlowDeck"
          onClick={() => void win.close()}
          aria-label="退出 FlowDeck"
        >
          <Icon d="M0.9 0.9 L9.1 9.1 M9.1 0.9 L0.9 9.1" size={10} />
        </button>
      </div>
    </div>
  );
}
