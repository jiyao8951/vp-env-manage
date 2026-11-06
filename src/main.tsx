import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readThemeMode } from "./lib/theme";
import "./styles.css";

// 在 React 挂载前先落主题，避免深色模式下启动时闪一下浅色
applyTheme(readThemeMode());

const el = document.getElementById("root");
if (!el) throw new Error("#root 节点缺失");

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
