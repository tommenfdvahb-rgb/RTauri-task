// 项目进度桌面挂件（Tauri v2 版）
//
// 本地只跑这个挂件，数据库 / 客户文件夹 / 每日提醒 / Web 管理页全部在服务端。
// HTTP 请求统一走 Rust 侧（reqwest），不受 WebView 跨域限制；
// 毛玻璃用窗口效果 API（亚克力 = SetWindowCompositionAttribute 的官方封装）。
//
// 配置保存在 exe 同目录 widget_config.json，字段与服务端项目里旧版 tkinter 挂件兼容。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

// ---------------- 配置 ----------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Config {
    server: String,
    bg_transparent: bool,
    glass_alpha: f64,
    on_top: bool,
    locked: bool,
    width: i32,
    height: i32,
    x: Option<i32>,
    y: Option<i32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: String::new(),
            bg_transparent: true,
            glass_alpha: 0.72,
            on_top: true,
            locked: false,
            width: 350,
            height: 580,
            x: None,
            y: None,
        }
    }
}

impl Config {
    fn clamp(&mut self) {
        self.glass_alpha = self.glass_alpha.clamp(0.1, 0.95);
        self.width = self.width.clamp(280, 2000);
        self.height = self.height.clamp(300, 2000);
        self.server = normalize_server(&self.server);
    }
}

fn config_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|d| d.join("widget_config.json"))
}

fn load_config() -> Config {
    let mut cfg = Config::default();
    if let Some(p) = config_path() {
        if let Ok(txt) = fs::read_to_string(&p) {
            if let Ok(c) = serde_json::from_str::<Config>(&txt) {
                cfg = c;
            }
        }
    }
    cfg.clamp();
    cfg
}

fn save_config(cfg: &Config) {
    if let Some(p) = config_path() {
        if let Ok(txt) = serde_json::to_string_pretty(cfg) {
            let _ = fs::write(p, txt);
        }
    }
}

fn normalize_server(url: &str) -> String {
    let mut url = url.trim().trim_end_matches('/').to_string();
    if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
        url = format!("http://{}", url);
    }
    url
}

// ---------------- 毛玻璃 ----------------

// 背景模式（染色浓度统一由网页层 CSS 控制，系统层只决定"有没有模糊"）：
// 毛玻璃开：acrylic（染色 alpha 置 0），磨砂看穿桌面；
// 毛玻璃关：清除系统效果（set_effects(None)），窗口本身逐像素透明 = 纯透明背景。
// 注：部分新版 Windows（24H2+）会忽略 SetWindowCompositionAttribute 的染色 alpha，
// 故透明度绝不依赖系统层。
fn apply_glass(win: &WebviewWindow, cfg: &Config) -> Result<(), String> {
    if cfg.bg_transparent {
        let effects: tauri::utils::config::WindowEffectsConfig = serde_json::from_value(
            serde_json::json!({
                "effects": ["acrylic"],
                "color": [18, 26, 48, 0]
            }),
        )
        .map_err(|e| e.to_string())?;
        win.set_effects(effects).map_err(|e| e.to_string())
    } else {
        win.set_effects(None).map_err(|e| e.to_string())
    }
}

// ---------------- 窗口几何记忆 ----------------

fn flush_geometry(win: &WebviewWindow) {
    if let (Ok(p), Ok(s)) = (win.outer_position(), win.outer_size()) {
        let mut cfg = load_config();
        cfg.x = Some(p.x);
        cfg.y = Some(p.y);
        cfg.width = s.width as i32;
        cfg.height = s.height as i32;
        save_config(&cfg);
    }
}

fn spawn_geometry_saver() -> mpsc::Sender<(i32, i32, i32, i32)> {
    let (tx, rx) = mpsc::channel::<(i32, i32, i32, i32)>();
    std::thread::spawn(move || {
        let mut geo = (0, 0, 0, 0);
        let mut last: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(400)) {
                Ok(g) => {
                    geo = g;
                    last = Some(Instant::now());
                }
                Err(_) => {
                    if let Some(t) = last {
                        if t.elapsed() >= Duration::from_millis(700) {
                            let mut cfg = load_config();
                            cfg.x = Some(geo.0);
                            cfg.y = Some(geo.1);
                            cfg.width = geo.2;
                            cfg.height = geo.3;
                            save_config(&cfg);
                            last = None;
                        }
                    }
                }
            }
        }
    });
    tx
}

// ---------------- 命令 ----------------

#[tauri::command]
fn get_config() -> Config {
    load_config()
}

#[tauri::command]
fn set_server(window: WebviewWindow, url: String) -> Config {
    let mut cfg = load_config();
    cfg.server = normalize_server(&url);
    save_config(&cfg);
    let _ = window.set_title("项目进度挂件");
    cfg
}

#[tauri::command]
fn set_glass(window: WebviewWindow, on: bool, alpha: f64) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.bg_transparent = on;
    cfg.glass_alpha = alpha.clamp(0.1, 0.95);
    save_config(&cfg);
    apply_glass(&window, &cfg)
}

#[tauri::command]
fn set_on_top(window: WebviewWindow, on: bool) {
    let mut cfg = load_config();
    cfg.on_top = on;
    save_config(&cfg);
    let _ = window.set_always_on_top(on);
}

// 上锁：禁止拖动/缩放（前端同时移除拖动区属性），状态持久化，重启后保持
#[tauri::command]
fn set_locked(window: WebviewWindow, on: bool) {
    let mut cfg = load_config();
    cfg.locked = on;
    save_config(&cfg);
    let _ = window.set_resizable(!on);
}

#[tauri::command]
fn quit(app: AppHandle, window: WebviewWindow) {
    flush_geometry(&window);
    app.exit(0);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
}

#[tauri::command]
async fn pick_files(title: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title)
            .pick_files()
            .map(|paths| {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn check_server(url: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{}/api/reminders", normalize_server(&url)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
async fn api_get(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    Ok(text)
}

#[tauri::command]
async fn api_send(url: String, method: String, body: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.to_uppercase().as_str() {
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if !body.is_empty() {
        req = req.header("Content-Type", "application/json").body(body);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    Ok(text)
}

#[tauri::command]
async fn upload_files(
    url: String,
    stage_id: i64,
    item_id: i64,
    paths: Vec<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let mut ok = 0usize;
    let mut errs: Vec<String> = Vec::new();
    for p in &paths {
        let bytes = match fs::read(p) {
            Ok(b) => b,
            Err(e) => {
                errs.push(format!("读取 {}: {}", p, e));
                continue;
            }
        };
        let fname = std::path::Path::new(p)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(fname)
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .text("stage_id", stage_id.to_string())
            .text("item_id", item_id.to_string())
            .part("file", part);
        match client.post(&url).multipart(form).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    ok += 1;
                } else {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    errs.push(format!("HTTP {}: {}", status.as_u16(), text));
                }
            }
            Err(e) => errs.push(e.to_string()),
        }
    }
    if errs.is_empty() {
        Ok(format!("已上传 {} 个文件", ok))
    } else {
        Err(errs.join("; "))
    }
}

// ---------------- 入口 ----------------

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_server,
            set_glass,
            set_on_top,
            set_locked,
            quit,
            open_url,
            pick_files,
            check_server,
            api_get,
            api_send,
            upload_files
        ])
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("main window not found");
            let cfg = load_config();

            let _ = win.set_always_on_top(cfg.on_top);
            let _ = win.set_resizable(!cfg.locked);
            if let (Some(x), Some(y)) = (cfg.x, cfg.y) {
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
            let _ = win.set_size(PhysicalSize::new(
                cfg.width.max(280) as u32,
                cfg.height.max(300) as u32,
            ));
            let _ = apply_glass(&win, &cfg);

            // 移动/缩放后防抖保存位置尺寸
            let tx = spawn_geometry_saver();
            let win_for_events = win.clone();
            win.on_window_event(move |e| match e {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if let (Ok(p), Ok(s)) =
                        (win_for_events.outer_position(), win_for_events.outer_size())
                    {
                        let _ = tx.send((p.x, p.y, s.width as i32, s.height as i32));
                    }
                }
                WindowEvent::CloseRequested { .. } => flush_geometry(&win_for_events),
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
