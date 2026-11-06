// 开发服务器端口探测：从 DEV_PORT_START 起逐个尝试，返回第一个可用端口。
//
// 这里只做「探测」，不负责「持有」：真正监听由 Vite 的 strictPort 完成。
// 探测与监听之间仍可能被杀出来的进程抢走端口，那种情况由 strictPort 让 Vite
// 显式失败，再由 scripts/dev.ts 换下一个端口重试，不靠运气。
//
// Windows 上「能绑定」不代表「没被占用」：别的进程用 0.0.0.0 监听时，
// 还可以继续绑定 127.0.0.1 而两边都不报错（SO_REUSEADDR 语义）。
// 所以先试探连接：能连上就说明已经有服务在该端口监听，直接跳过。

import { execFileSync } from "node:child_process";
import { connect, createServer } from "node:net";

/** 起始端口：固定占用容易和其他程序撞车；只在首个实例启动时分配 */
export const DEV_PORT_START = 1520;
/** 最多向后探测多少个端口 */
export const DEV_PORT_TRIES = 20;

/** 端口当前的监听者；只在解释冲突时查询，不参与端口选择 */
export interface PortOwner {
  pid: number;
  command: string;
}

/**
 * 查询端口监听者（Windows 用系统自带命令）。
 * 仅用于冲突时打印可排查信息：查不到或不在 Windows 上就返回 null，不影响启动。
 */
export function getPortOwner(port: number): PortOwner | null {
  if (process.platform !== "win32") return null;
  const script =
    `$p = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1).OwningProcess; ` +
    `if ($p) { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; ` +
    `Write-Output ($p.ToString() + "|" + $c.CommandLine) }`;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    const [pid, ...command] = out.split("|");
    const ownerPid = Number(pid);
    if (!ownerPid) return null;
    return { pid: ownerPid, command: command.join("|").trim() };
  } catch {
    return null;
  }
}

/** 单个地址上是否可以连上（能连上说明有服务在监听） */
function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });
}

/** 端口上是否已有服务在监听；Vite 的 localhost 在本机可能只绑 ::1，两个地址都要看 */
function isListening(port: number): Promise<boolean> {
  return canConnect(port, "127.0.0.1").then((v4) => v4 || canConnect(port, "::1"));
}

/** 端口能否被绑定（能绑定即视为可用，随即释放给 Vite 使用） */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 端口是否可用：没有服务在监听，且自己也能绑定 */
export async function isPortFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  if (await isListening(port)) return false;
  return canBind(port, host);
}

/** 从 start 起找第一个可用端口；连续 tries 个都被占用则抛错，不静默兜底 */
export async function findFreePort(
  start = DEV_PORT_START,
  tries = DEV_PORT_TRIES,
  host = "0.0.0.0",
): Promise<number> {
  for (let i = 0; i < tries; i += 1) {
    const port = start + i;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`端口 ${start}–${start + tries - 1} 全部不可用（被占用或无法绑定）`);
}
