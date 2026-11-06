import Icon from "./Icon";
import TitleBar from "./TitleBar";

interface Props {
  error: string;
  backupPath: string | null;
  busy?: boolean;
  onReload: () => void;
  onRestore: () => void;
  onOpenFolder: () => void;
}

/**
 * 配置损坏时的独立恢复向导。
 * 明确告诉用户当前处于「降级状态」：没有回退空配置，也没有写回任何文件。
 * 原 config.json 与备份都保持原样，用户可自行修复后重新加载。
 */
export default function ConfigRecovery({
  error,
  backupPath,
  busy,
  onReload,
  onRestore,
  onOpenFolder,
}: Props) {
  return (
    <div className="shell">
      <TitleBar subtitle="配置恢复" />
      <div className="workspace">
        <div className="recovery-wrap">
          <div className="recovery-card">
            <div className="recovery-banner" role="status">
              <span className="status-pill warn">
                <span className="status-dot" />
                降级状态
              </span>
              <span className="recovery-banner-text">
                配置未加载 · 已停止自动保存，避免覆盖你的数据
              </span>
            </div>

            <div className="page-head">
              <div className="page-title-row">
                <span className="page-icon">
                  <Icon name="alert" size={18} />
                </span>
                <div>
                  <h2 className="page-title">配置文件无法读取</h2>
                  <p className="page-desc">
                    为避免覆盖你的设置，FlowDeck 没有回退到空配置，也没有写入任何文件。
                  </p>
                </div>
              </div>
            </div>

            <ol className="recovery-steps">
              <li>
                <span className="recovery-step-index">1</span>
                <div>
                  <div className="recovery-step-title">查看错误详情</div>
                  <pre className="recovery-error">{error}</pre>
                </div>
              </li>
              <li>
                <span className="recovery-step-index">2</span>
                <div>
                  <div className="recovery-step-title">选择恢复方式</div>
                  <p className="recovery-step-desc">
                    {backupPath
                      ? `检测到上一份可用备份：${backupPath}`
                      : "未找到可用备份（config.json.bak）。原文件保持不变，可手动修复后重新加载。"}
                  </p>
                  <div className="recovery-actions">
                    <button className="btn primary" onClick={onReload} disabled={busy}>
                      <Icon name="refresh" size={14} />
                      重新加载
                    </button>
                    {backupPath ? (
                      <button className="btn" onClick={onRestore} disabled={busy}>
                        <Icon name="layers-stack" size={14} />
                        从备份恢复
                      </button>
                    ) : null}
                    <button className="btn ghost" onClick={onOpenFolder} disabled={busy}>
                      <Icon name="folder" size={14} />
                      打开配置目录
                    </button>
                  </div>
                </div>
              </li>
              <li>
                <span className="recovery-step-index">3</span>
                <div>
                  <div className="recovery-step-title">手动修复（可选）</div>
                  <p className="recovery-step-desc">
                    在配置目录中修正 <code>config.json</code> 的 JSON
                    语法后，回到这里点「重新加载」。 FlowDeck
                    在配置可用之前不会写盘，因此手动修改不会被覆盖。
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
