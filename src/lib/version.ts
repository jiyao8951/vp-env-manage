export function parseSemver(v: string): [number, number, number] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** 语义化版本倒序比较（大版本 → 小版本 → 补丁） */
export function compareDesc(a: string, b: string): number {
  const [amaj, amin, apat] = parseSemver(a);
  const [bmaj, bmin, bpat] = parseSemver(b);
  if (amaj !== bmaj) return bmaj - amaj;
  if (amin !== bmin) return bmin - amin;
  return bpat - apat;
}

export interface MajorGroup<T> {
  major: number;
  items: T[];
}

/**
 * 按大版本分组，每组内取最新的 `limit` 个版本，大版本倒序排列。
 * 用于「查看每个大版本最新的 N 个版本」。
 */
export function groupByMajor<T>(
  items: T[],
  versionOf: (item: T) => string,
  limit: number,
  minMajor = 0,
): MajorGroup<T>[] {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const major = parseSemver(versionOf(item))[0];
    if (major < minMajor) continue;
    const list = buckets.get(major);
    if (list) list.push(item);
    else buckets.set(major, [item]);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, list]) => ({
      major,
      items: [...list].sort((a, b) => compareDesc(versionOf(a), versionOf(b))).slice(0, limit),
    }));
}

/** 去掉 `v` 前缀，统一展示 */
export function displayVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}
