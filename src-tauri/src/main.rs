// 隐藏 release 模式下额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flowdeck_lib::run()
}
