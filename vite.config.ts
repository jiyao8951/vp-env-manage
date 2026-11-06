import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import { DEV_PORT_START } from "./scripts/dev-port.ts";

const host = process.env.TAURI_DEV_HOST;
/** 开发端口：scripts/dev.ts 动态探测后经环境变量传入；单独跑 bun run dev 时回落到起始端口 */
const devPort = Number(process.env.FLOWDECK_DEV_PORT) || DEV_PORT_START;

// https://vite.dev/config/
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [react()]),
  clearScreen: false,
  server: {
    port: devPort,
    // 端口被抢占时显式失败，而不是悄悄换一个导致 Tauri 的 devUrl 连错端口
    strictPort: true,
    host: host || false,
    // 真机调试时 HMR 走独立端口，跟随动态端口 +1；桌面开发不指定，跟随 server 端口
    hmr: host ? { protocol: "ws", host, port: devPort + 1 } : undefined,
    watch: {
      // src-tauri 变更由 tauri 自身触发重编译，避免 vite 反复重启
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // Vite 8 默认使用内置的 oxc 压缩器，无需额外安装 esbuild
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
