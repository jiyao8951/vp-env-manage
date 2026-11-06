/** FlowDeck 的品牌图形：三层递进的「卡片」，与应用图标保持一致 */
export function FlowGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="16" height="4.6" rx="2.3" opacity="0.98" />
      <rect x="4" y="9.7" width="12.6" height="4.6" rx="2.3" opacity="0.82" />
      <rect x="4" y="15.4" width="9.2" height="4.6" rx="2.3" opacity="0.64" />
    </svg>
  );
}

/** 标题栏 / 关于页使用的品牌方块 */
export default function LogoMark({
  size = 22,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`logo-mark ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <FlowGlyph size={Math.round(size * 0.66)} />
    </span>
  );
}
