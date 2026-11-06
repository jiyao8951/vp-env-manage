import pkg from "../../package.json" with { type: "json" };

/** 应用名与版本号唯一出处（package.json），避免界面各处硬编码漂移 */
export const APP_NAME = "FlowDeck";
export const APP_VERSION: string = pkg.version;
