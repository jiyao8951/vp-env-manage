#!/usr/bin/env bun
// FlowDeck 一键打包：构建裸 exe，并把唯一的产物放到 dist-release/FlowDeck.exe
//
// 用法：bun run package / bun run tauri:build（或 bun scripts/package.ts）
//
// 说明：
// - 只出绿色免安装版：`tauri build --no-bundle`，不生成 NSIS 安装包，
//   因此无需 NSIS 工具链，也不会联网下载任何东西。
// - 不生成 zip / 说明文件 / 子目录：dist-release/ 下只保留一个可执行文件。
// - src-tauri/target/ 是 Rust 构建缓存（数百 MB），不属于分发物，不要一起拷贝。
// - 用 Bun 而非 shell 实现：不依赖 Git Bash / stat / numfmt，也不受 CRLF 影响。

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APP_NAME = "FlowDeck";
const BIN_NAME = "flowdeck";
const EXE_EXT = process.platform === "win32" ? ".exe" : "";
const DIST = join(ROOT, "dist-release");
const BUILT_EXE = join(ROOT, "src-tauri", "target", "release", `${BIN_NAME}${EXE_EXT}`);

function fail(message: string): never {
  console.error(`!! ${message}`);
  process.exit(1);
}

function hasCargo(): boolean {
  return spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;
}

// 不写死用户名：cargo 不在 PATH 时补上当前用户的 Rust 工具链目录
if (!hasCargo()) {
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    if (!home) continue;
    const bin = join(home, ".cargo", "bin");
    if (existsSync(bin)) {
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    }
  }
}
if (!hasCargo()) {
  fail("未找到 cargo，请先安装 Rust stable（MSVC 工具链）并确保在 PATH 中");
}

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

if (process.platform === "win32") {
  console.log("==> 结束可能占用产物的旧进程");
  for (const name of [`${BIN_NAME}.exe`, `${APP_NAME}.exe`]) {
    spawnSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
  }
}

// ------------------------------------------------------------------ 构建

const tauriCli = join(ROOT, "node_modules", ".bin", `tauri${EXE_EXT}`);
if (!existsSync(tauriCli)) {
  fail("未找到 tauri CLI，请先执行 bun install");
}

console.log("==> 构建前端 + Rust（仅裸 exe，不打包安装程序）");
const build = spawnSync(tauriCli, ["build", "--no-bundle"], { cwd: ROOT, stdio: "inherit" });
if (build.error) {
  fail(`启动 tauri CLI 失败：${build.error.message}`);
}
if (build.status !== 0) {
  fail(`构建失败（退出码 ${build.status ?? "未知"}）`);
}

if (!existsSync(BUILT_EXE)) {
  fail(`构建结束但未找到 ${BUILT_EXE}`);
}

// ------------------------------------------------------------- 组装分发物

console.log(`==> 清理旧产物：${DIST}`);
// 整目录重建，保证里面只剩这一个 exe（不留上一版的 zip、说明文件、子目录）
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const output = join(DIST, `${APP_NAME}${EXE_EXT}`);
console.log(`==> 输出 ${output}`);
copyFileSync(BUILT_EXE, output);

const size = statSync(output).size;
if (size < 1_000_000) {
  fail(`可执行文件异常（${size} 字节）`);
}

const megabytes = (size / 1024 / 1024).toFixed(1);
console.log();
console.log(`==> 完成：${output}（${megabytes} MB）`);
console.log(`    版本 v${version} · 双击即用，仅依赖系统自带的 WebView2 运行时`);
for (const name of readdirSync(DIST)) {
  console.log(`    ${name}`);
}
