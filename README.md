# 项目进度桌面挂件（Rust + Tauri v2）

服务端「项目进度跟进系统」（Python + FastAPI）的 Windows 桌面挂件客户端，用 Rust + Tauri v2 重写，
替代旧版 tkinter 实现。数据库、客户文件夹、每日提醒、Web 管理页全部在服务端，本地只跑这一个 exe。

## 功能

- 无边框窗口，背景两种模式透明度均可调（10%~95% 实时生效）：**毛玻璃**（DWM 亚克力磨砂看穿桌面）
  与**纯透明**（无模糊）；⚙ 里切换，染色由网页层渲染，任何 Windows 版本都可见
- 显示超期 / 临近截止项目、每个进行中项目的当前阶段与待办
- **可直接操作**：勾选完成待办、⬆ 上传文件（自动标记材料完成）、快速添加待办、完成当前阶段
- 60 秒自动刷新；标题区/底部提示条按住拖动移动，窗口边缘拖拽调整大小（位置尺寸自动记忆）
- 🔓 **上锁**：锁定后不能拖动/缩放，防止误操作（状态持久化，重启保持）
- 📌 切换置顶；🌐 一键打开服务端管理页面
- 配置保存在 exe 同目录 `widget_config.json`（与旧版 tkinter 挂件字段兼容）

## 使用

1. 服务端先跑起来：在服务器上运行 `项目进度跟进.exe --host 0.0.0.0`（或 `py app/main.py --host 0.0.0.0`），放行 8300 端口
2. 下载本挂件 exe，双击运行，首次启动填服务端地址（如 `192.168.1.10:8300`）
3. 单机使用时填 `127.0.0.1:8300` 即可

## 下载 / 构建

**GitHub Actions 自动构建**（推荐，本地无需安装任何工具链）：

- 推送到 `main` 或手动触发 workflow → 在 Actions 运行页的 Artifacts 下载 `项目进度挂件`
- 推送 `v*` 标签（如 `git tag v2.0.0 && git push origin v2.0.0`）→ 自动创建 Release 并附上 exe

**本地构建**（需要 rustup + MSVC Build Tools）：

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml
# 产物：src-tauri/target/release/project-widget.exe
```

开发调试：`cargo run --manifest-path src-tauri/Cargo.toml`（前端在 `src/`，改 Rust 侧需重新编译；
窗口效果等配置见 `src-tauri/tauri.conf.json`）。

## 与服务端的接口

| 用途 | 请求 |
|---|---|
| 汇总提醒（超期/临近） | `GET /api/reminders` |
| 项目列表 | `GET /api/projects` |
| 项目详情（阶段/待办） | `GET /api/projects/{id}` |
| 勾选/取消待办 | `PATCH /api/items/{id}` |
| 快速添加待办 | `POST /api/stages/{id}/items` |
| 完成当前阶段 | `PATCH /api/stages/{id}` |
| 上传材料文件 | `POST /api/projects/{id}/files`（multipart） |

所有 HTTP 请求在 Rust 侧用 reqwest 发出，不受 WebView 跨域限制；服务端零改动。

## 目录结构

```
├── src/                      前端（纯 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src-tauri/
│   ├── src/main.rs           Rust 侧：窗口效果、配置、HTTP 命令、文件对话框
│   ├── tauri.conf.json       窗口与打包配置（无边框、透明、亚克力）
│   ├── capabilities/         Tauri v2 权限声明
│   └── icons/icon.ico
└── .github/workflows/        GitHub Actions 构建流水线
```
