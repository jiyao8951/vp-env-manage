#!/usr/bin/env bun
// FlowDeck 开发启动器：先确认没有已在运行的实例 → 动态选端口 → 起 Vite → 用临时 config
// 覆盖 devUrl → 起 tauri dev。
//
// 用法：bun run tauri:dev（= bun scripts/dev.ts）
//
// 为什么不交给 tauri 的 beforeDevCommand：
// - devUrl 必须与 Vite 实际端口一致，而端口是运行时才确定的，只能先选端口、再写覆盖配置；
// - 先确认 Vite 真的在这个端口上监听，再拉起 Tauri，避免窗口连上别人的服务或还没起来的地址；
// - 端口被抢占时 strictPort 让 Vite 显式失败，脚本据退出码换下一个端口重试。
//
// 单实例：程序已在运行时不再起第二份 Vite/Tauri，而是尝试把已有窗口切到前台；
// 激活失败则提示用户从任务栏切换。退出码：0 = 已聚焦已有窗口，2 = 已有实例但不重复启动。

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEV_PORT_START, DEV_PORT_TRIES, findFreePort, getPortOwner } from "./dev-port";

const ROOT = resolve(import.meta.dirname, "..");
const TAURI_CLI_ENTRY = join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
/** Vite 从启动到打印监听地址的上限 */
const READY_TIMEOUT_MS = 25_000;
/** 探测后被抢占时的最多重试次数 */
const MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 占用者是否就是本仓库的另一个 Vite（参考实现的 isThisRepoDevServer 思路，仅用于提示） */
function isOwnDevServerCommand(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\\/g, "/");
  const repo = ROOT.toLowerCase().replace(/\\/g, "/");
  return normalized.includes(repo) && /(vite|vp\.exe|vp dev|--strictport)/.test(normalized);
}

/** 端口占用者的一句话描述：冲突时给出可直接排查的 PID 与命令行 */
function describePortOwner(port: number): string {
  const owner = getPortOwner(port);
  if (!owner) return "占用者未知";
  const self = isOwnDevServerCommand(owner.command) ? "（本仓库另一个 dev server）" : "";
  if (!owner.command) return `PID ${owner.pid}${self}`;
  const command = owner.command.length > 120 ? `${owner.command.slice(0, 120)}…` : owner.command;
  return `PID ${owner.pid}${self}（${command}）`;
}

/** 去掉终端颜色码，便于匹配 Vite 打印的地址 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

interface ExistingApp {
  pid: number;
  title: string;
  path: string;
}

interface ExistingDevServer {
  port: number;
  pid: number;
  command: string;
}

interface ExistingInstance {
  apps: ExistingApp[];
  devServers: ExistingDevServer[];
}

/** 一次 PowerShell 查询同时给出两条线索：本项目的应用进程、1520 起端口段里属于本仓库的 Vite */
const DETECT_SCRIPT = `
$repo = $env:FLOWDECK_REPO_ROOT
$devExe = [System.IO.Path]::GetFullPath((Join-Path $repo 'src-tauri\\target\\debug\\flowdeck.exe'))
$pkgExe = [System.IO.Path]::GetFullPath((Join-Path $repo 'dist-release\\FlowDeck.exe'))
foreach ($p in @(Get-Process -Name flowdeck -ErrorAction SilentlyContinue)) {
  $path = $null
  try { $path = $p.Path } catch { }
  if ($path -and ($path -ieq $devExe -or $path -ieq $pkgExe)) {
    Write-Output ('APP|' + $p.Id + '|' + $p.MainWindowTitle + '|' + $path)
  }
}
foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge __START__ -and $_.LocalPort -le __END__ })) {
  $ownerId = $c.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerId)
  if ($proc -and $proc.CommandLine) {
    $cmd = $proc.CommandLine
    if ($cmd.ToLower().Contains($repo.ToLower()) -and ($cmd -match 'vite|vp\\.exe|vp dev|--strictport')) {
      Write-Output ('DEV|' + $c.LocalPort + '|' + $ownerId + '|' + $cmd)
    }
  }
}
`;

function detectExistingInstance(): ExistingInstance {
  const empty: ExistingInstance = { apps: [], devServers: [] };
  if (process.platform !== "win32") return empty;

  const script = DETECT_SCRIPT.replace("__START__", String(DEV_PORT_START)).replace(
    "__END__",
    String(DEV_PORT_START + DEV_PORT_TRIES - 1),
  );
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, FLOWDECK_REPO_ROOT: ROOT },
    },
  );
  if (result.status !== 0 || !result.stdout) return empty;

  const apps: ExistingApp[] = [];
  const devServers: ExistingDevServer[] = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("APP|")) {
      const [, pid, title, path] = line.split("|");
      const appPid = Number(pid);
      if (appPid) apps.push({ pid: appPid, title: title ?? "", path: path ?? "" });
    } else if (line.startsWith("DEV|")) {
      const [, port, pid, command] = line.split("|");
      const portNumber = Number(port);
      const serverPid = Number(pid);
      if (portNumber && serverPid)
        devServers.push({ port: portNumber, pid: serverPid, command: command ?? "" });
    }
  }
  return { apps, devServers };
}

/** 按 PID 枚举顶层窗口（含被最小化的窗口），恢复并切到前台；同名但不同 PID 的窗口不会误激活 */
const ACTIVATE_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FlowDeckWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int ownerPid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    public static IntPtr Best;
    public static int Target;
    public static bool Find(int pid) {
        Best = IntPtr.Zero;
        Target = pid;
        EnumWindows(new EnumWindowsProc(Check), IntPtr.Zero);
        return Best != IntPtr.Zero;
    }
    private static bool Check(IntPtr hWnd, IntPtr lParam) {
        int owner;
        GetWindowThreadProcessId(hWnd, out owner);
        if (owner != Target) return true;
        if (GetWindowTextLength(hWnd) == 0) return true;
        if (IsWindowVisible(hWnd)) { Best = hWnd; return false; }
        if (Best == IntPtr.Zero) Best = hWnd;
        return true;
    }
}
'@
if (-not [FlowDeckWindow]::Find([int]$env:FLOWDECK_PID)) { 'activated=False reason=no-window'; exit 0 }
$h = [FlowDeckWindow]::Best
[FlowDeckWindow]::ShowWindow($h, 9) | Out-Null
$ok = [FlowDeckWindow]::SetForegroundWindow($h)
if (-not $ok) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $ok = $shell.AppActivate([int]$env:FLOWDECK_PID)
  } catch { }
}
'activated=' + $ok + ' hwnd=' + $h.ToInt64()
`;

interface ActivateResult {
  ok: boolean;
  reason: string;
}

function activateExistingWindow(pid: number): ActivateResult {
  if (process.platform !== "win32") return { ok: false, reason: "当前平台不支持窗口激活" };
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ACTIVATE_SCRIPT],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, FLOWDECK_PID: String(pid) },
    },
  );
  const output = (result.stdout ?? "").trim();
  if (/activated=True/.test(output)) return { ok: true, reason: "" };
  if (output.includes("no-window"))
    return { ok: false, reason: "未找到可激活的窗口（可能仍在启动）" };
  return { ok: false, reason: output || "窗口激活脚本执行失败" };
}

/** 已有实例时聚焦并退出；保证第二次启动不会新增 Vite 监听或第二个应用实例 */
function ensureSingleInstance(): void {
  const existing = detectExistingInstance();

  if (existing.apps.length > 0) {
    const app = existing.apps[0];
    const title = app.title || "FlowDeck";
    const activated = activateExistingWindow(app.pid);
    if (activated.ok) {
      console.log(`==> 程序已在运行：PID ${app.pid}，窗口「${title}」，已切到前台`);
      console.log("==> 本次不再是启动第二份，直接退出");
      process.exit(0);
    }
    console.error(
      `!! 程序已在运行：PID ${app.pid}，窗口「${title}」，但自动切到前台失败（${activated.reason}）`,
    );
    console.error("   请从任务栏或已打开的窗口切换到 FlowDeck；本次不会启动新实例");
    process.exit(2);
  }

  if (existing.devServers.length > 0) {
    const server = existing.devServers[0];
    console.error(
      `!! 本项目已有开发服务器在端口 ${server.port} 运行（PID ${server.pid}），可能正在启动中`,
    );
    console.error("   请稍候等待窗口出现，或先结束该进程（避免重复启动）；本次不会启动新实例");
    process.exit(2);
  }
}

interface ViteRun {
  child: ChildProcess;
  /** Vite 真正打印出 `http://localhost:<port>` 时 resolve true；退出/出错时 false */
  ready: Promise<boolean>;
}

function startVite(port: number): ViteRun {
  const child = spawn(process.execPath, ["run", "dev"], {
    cwd: ROOT,
    env: { ...process.env, FLOWDECK_DEV_PORT: String(port) },
    // stdin 继承；stdout/stderr 转接出来，同时扫描就绪行
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let settle: (ready: boolean) => void = () => {};
  let settled = false;
  const ready = new Promise<boolean>((resolveReady) => {
    settle = resolveReady;
  });
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    settle(ok);
  };

  const marker = `http://localhost:${port}`;
  let buffer = "";
  const scan = (chunk: Buffer) => {
    // Vite 的地址行可能被拆成多次 write，先累积再匹配
    buffer = (buffer + stripAnsi(String(chunk))).slice(-8192);
    if (buffer.includes(marker)) finish(true);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    scan(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    scan(chunk);
  });
  child.once("exit", () => finish(false));
  child.once("error", () => finish(false));

  return { child, ready };
}

/** 结束子进程及其子进程（Vite 是 bun → vp → vite 的进程树） */
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function fail(message: string): never {
  console.error(`!! ${message}`);
  process.exit(1);
}

async function main() {
  ensureSingleInstance();

  if (!existsSync(TAURI_CLI_ENTRY)) {
    fail(`未找到 tauri CLI（${TAURI_CLI_ENTRY}），请先执行 vp install`);
  }

  let vite: ChildProcess | null = null;
  let port = DEV_PORT_START;
  let next = DEV_PORT_START;
  let ready = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    port = await findFreePort(next);
    // 跳过窗口里的端口说明为什么被跳：冲突时能直接看到占用进程
    for (let skipped = next; skipped < port; skipped += 1) {
      console.log(`==> ${skipped} 已被占用（${describePortOwner(skipped)}），跳过`);
    }
    console.log(`==> 第 ${attempt} 次探测：端口 ${port} 可用，启动 Vite（strictPort）`);
    const run = startVite(port);
    vite = run.child;
    ready = await Promise.race([run.ready, sleep(READY_TIMEOUT_MS).then(() => false)]);
    if (ready) break;
    killTree(run.child);
    const why =
      run.child.exitCode !== null
        ? "Vite 在开始监听前退出（端口可能刚被抢占）"
        : `Vite ${READY_TIMEOUT_MS / 1000}s 内没有打印监听地址`;
    console.error(`!! ${why}：${port}（${describePortOwner(port)}），换下一个端口重试`);
    next = port + 1;
  }

  if (!ready || !vite) {
    fail(`连续 ${MAX_ATTEMPTS} 次都没能起稳开发服务器`);
  }

  console.log(`==> dev server 就绪：http://localhost:${port}`);
  console.log(`==> 拉起 tauri dev，devUrl 同步指向 ${port}`);

  // 单文件覆盖配置：带 pid 避免并发实例互相覆盖，退出时删除，不留临时目录
  const overlay = join(tmpdir(), `flowdeck-tauri-dev-${process.pid}.json`);
  writeFileSync(
    overlay,
    JSON.stringify(
      { build: { devUrl: `http://localhost:${port}`, beforeDevCommand: "" } },
      null,
      2,
    ),
  );
  console.log(`==> 临时配置：${overlay}（devUrl=http://localhost:${port}，beforeDevCommand 置空）`);

  const tauri = spawn(process.execPath, [TAURI_CLI_ENTRY, "dev", "--config", overlay], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killTree(vite);
    rmSync(overlay, { force: true });
  };

  const stop = (code: number) => {
    killTree(tauri);
    cleanup();
    process.exit(code);
  };

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  process.on("exit", cleanup);

  tauri.on("error", (error) => {
    console.error(`!! 启动 tauri dev 失败：${error.message}`);
    cleanup();
    process.exit(1);
  });
  tauri.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
