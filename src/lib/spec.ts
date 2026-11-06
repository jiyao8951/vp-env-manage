/** 判断一个安装 spec 是否指向 Node.js（而不是包管理器）。 */
const PM_NAMES = new Set(["pnpm", "npm", "yarn", "bun"]);
const NODE_TAGS = new Set(["lts", "latest", "current"]);

export function isNodeSpec(spec: string): boolean {
  const s = spec.trim();
  if (!s) return false;
  const at = s.indexOf("@");
  // `@scope/...` 不是 vp env 的版本 spec
  if (at === 0) return false;
  const name = (at >= 0 ? s.slice(0, at) : s).toLowerCase();
  if (PM_NAMES.has(name)) return false;
  if (name === "node") return true;
  if (NODE_TAGS.has(name)) return true;
  if (name.startsWith("lts/")) return true;
  // 裸版本号（22 / 22.11.0 / v22.11.0）默认视为 Node
  return /^v?\d/.test(name);
}
