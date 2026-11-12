import { useState } from "react";
import Icon from "./Icon";

interface Props {
  text: string;
  /** 产生这条输出的操作，例如 `vp env install` */
  source?: string;
  /** 输出时间戳 */
  at?: number | null;
  onClear: () => void;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 命令输出面板：切页不清空，通过来源标识区分是哪一次操作产生的输出。
 */
export default function ConsolePanel({ text, source, at, onClear }: Props) {
  const [copied, setCopied] = useState(false);
  const empty = text.trim().length === 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时保持原样，用户仍可手动选中复制 */
    }
  };

  return (
    <section className="console-panel" aria-label="命令输出">
      <div className="console-panel-head">
        <span className="section-icon">
          <Icon name="terminal" size={14} />
        </span>
        <h4 className="section-title">命令输出</h4>
        {source ? <span className="console-source">{source}</span> : null}
        {at ? <span className="console-time">· {clock(at)}</span> : null}
        <div className="console-panel-actions">
          <button className="btn ghost sm" onClick={() => void copy()} disabled={empty}>
            <Icon name={copied ? "check" : "layers-stack"} size={12} />
            {copied ? "已复制" : "复制"}
          </button>
          <button className="btn ghost sm" onClick={onClear} disabled={empty}>
            <Icon name="x" size={12} />
            清除
          </button>
        </div>
      </div>
      <pre className={empty ? "console empty" : "console"}>
        {empty ? "暂无输出 · 安装、卸载、切换默认版本等操作的结果会显示在这里" : text}
      </pre>
    </section>
  );
}
