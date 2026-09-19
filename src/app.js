/* 项目进度挂件逻辑（Tauri v2 版）
   与服务端的交互全部经 Rust 侧命令转发（api_get / api_send / upload_files），
   避开 WebView 跨域限制；接口路径与旧版 tkinter 挂件一致。 */

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayDiff = d => Math.round((new Date(d + "T00:00:00") - new Date(todayStr() + "T00:00:00")) / 86400000);

let SERVER = "";
let ON_TOP = true;
let GLASS = { bg_transparent: true, glass_alpha: 0.72 };
let firstRun = false;
let lastCols = 0;
let loadBusy = false;
let previewTimer = null;

function normServer(u) {
  u = String(u || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

/* 从 Rust 报错文本里提取服务端返回的 detail.message */
function errMsg(e) {
  const m = String(e).match(/HTTP \d+: ([\s\S]*)$/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      if (j && j.detail && j.detail.message) return j.detail.message;
    } catch {}
    return m[1] || "请求失败";
  }
  return String(e);
}

async function apiGet(path) {
  return JSON.parse(await invoke("api_get", { url: SERVER + path }));
}
async function apiSend(path, method, body) {
  const raw = await invoke("api_send", {
    url: SERVER + path, method, body: JSON.stringify(body ?? {}),
  });
  return JSON.parse(raw);
}

/* ---------- 渲染 ---------- */

function alertRow(cls, tag, name, sub) {
  return `<div class="alert ${cls} span-all" onclick="openApp()">
    <span class="tag ${cls === "late" ? "late" : "near"}">${tag}</span>
    <span>${esc(name)}<div class="sub">预期完成 ${esc(sub ?? "")}</div></span></div>`;
}

function itemRow(pid, sid, i) {
  const dd = i.due_date ? dayDiff(i.due_date) : null;
  const due = dd === null ? "" :
    `<span class="due ${dd < 0 ? "over" : ""}">${dd < 0 ? `已超 ${-dd} 天` : dd === 0 ? "今天到期" : `剩 ${dd} 天`}</span>`;
  return `<div class="todo">
    <input type="checkbox" title="标记完成" onchange="toggleItem(this, ${i.id})">
    <span class="tn">${esc(i.name)}${i.owner ? ` <span style="color:#8fa2c9">· ${esc(i.owner)}</span>` : ""} ${due}</span>
    <button class="up" title="上传文件（自动标记该材料完成）"
      data-nm="${esc(i.name)}" onclick="uploadFor(${pid}, ${sid}, ${i.id}, this)">⬆ 上传</button>
  </div>`;
}

function completedRow(i) {
  return `<div class="todo completed">
    <span class="ck">✓</span>
    <span class="tn">${esc(i.name)}${i.completed_at ? ` <span style="color:#7488ad">${esc(i.completed_at)}</span>` : ""}</span>
  </div>`;
}

function projectCard(p) {
  const stages = p.stages || [];
  const cur = stages.find(s => s.status !== "已完成");
  const done = stages.filter(s => s.status === "已完成").length;
  const pct = stages.length ? Math.round(done / stages.length * 100) : 0;
  let rows = "", doneBlock = "", tail = "";
  if (cur) {
    const todos = (cur.items || []).filter(i => i.status === "待准备");
    const dones = (cur.items || []).filter(i => i.status !== "待准备");
    rows = todos.map(i => itemRow(p.id, cur.id, i)).join("")
      || `<div class="todo"><span class="tn" style="color:#8fa2c9">该阶段暂无待办，可推进下一步</span></div>`;
    if (dones.length)
      doneBlock = `<div class="donetip">— 已完成 ${dones.length} 项 —</div>`
        + dones.map(completedRow).join("");
    tail = `<div class="addrow">
        <input id="nt-${cur.id}" placeholder="＋ 快速添加待办，回车保存"
          onkeydown="if(event.key==='Enter')addTodo(${cur.id}, this)">
        <button onclick="addTodo(${cur.id}, document.getElementById('nt-${cur.id}'))">添加</button>
      </div>
      <button class="done-stage" onclick="finishStage(${cur.id})">✓ 完成当前阶段「${esc(cur.name)}」</button>`;
  }
  return `<div class="proj">
    <div class="p-head">
      <span class="p-name" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="p-stage">${cur ? esc(cur.name) : "全部完成"}</span>
      <span class="p-prog">${done}/${stages.length}</span>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    ${rows}${doneBlock}${tail}
  </div>`;
}

function render(digest, details) {
  const c = (digest.counts && digest.counts.total) || 0;
  const cnt = document.getElementById("cnt");
  cnt.hidden = !c;
  cnt.textContent = c;
  document.getElementById("foot-time").textContent =
    "最后更新 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  const cols = Math.max(1, Math.min(3, Math.floor(document.body.clientWidth / 340)));
  lastCols = cols;
  let html = "";
  if (digest.overdue_projects && digest.overdue_projects.length)
    html += `<div class="sec-t span-all">⚠️ 超期项目</div>`
      + digest.overdue_projects.map(x => alertRow("late", "逾期", x.name, x.expected_end)).join("");
  if (digest.near_projects && digest.near_projects.length)
    html += `<div class="sec-t span-all">⏳ 临近截止</div>`
      + digest.near_projects.map(x => alertRow("near", "临近", x.name, x.expected_end)).join("");
  html += `<div class="sec-t span-all">🗂 进行中的项目</div>`;
  html += details.map(projectCard).join("")
    || `<div class="empty span-all">暂无进行中的项目<br>到管理页面新建一个吧</div>`;
  const list = document.getElementById("list");
  list.style.setProperty("--cols", cols);
  list.innerHTML = `<div class="grid">${html}</div>`;
}

/* ---------- 数据 ---------- */

async function load() {
  if (loadBusy) return;
  loadBusy = true;
  const box = document.getElementById("list");
  try {
    if (!SERVER) {
      box.innerHTML = `<div class="empty">尚未配置服务器<br>点 ⚙ 填写服务端地址</div>`;
      return;
    }
    const [digest, projects] = await Promise.all([apiGet("/api/reminders"), apiGet("/api/projects")]);
    const active = projects.filter(p => p.status === "进行中");
    const details = (await Promise.all(active.map(p => apiGet(`/api/projects/${p.id}`).catch(() => null))))
      .filter(Boolean);
    render(digest, details);
  } catch (e) {
    box.innerHTML = `<div class="err">⚠️ 无法连接服务器<br>${esc(errMsg(e))}<br><br>
      <span style="cursor:pointer;text-decoration:underline" onclick="openSetup()">修改服务器地址</span></div>`;
  } finally {
    loadBusy = false;
  }
}

/* ---------- 动作 ---------- */

async function toggleItem(input, iid) {
  input.disabled = true;
  try {
    await apiSend(`/api/items/${iid}`, "PATCH", { status: input.checked ? "已完成" : "待准备" });
    load();
  } catch (e) {
    input.checked = !input.checked;
    input.disabled = false;
    alert(errMsg(e));
  }
}

async function addTodo(sid, input) {
  const name = input.value.trim();
  if (!name) return;
  try {
    await apiSend(`/api/stages/${sid}/items`, "POST", { name, required: false });
    load();
  } catch (e) { alert(errMsg(e)); }
}

async function finishStage(sid) {
  if (!confirm("确认完成该阶段？（必备项未完成时会被服务端拒绝）")) return;
  try {
    await apiSend(`/api/stages/${sid}`, "PATCH", { status: "已完成" });
    load();
  } catch (e) { alert("无法完成：" + errMsg(e)); }
}

async function uploadFor(pid, sid, iid, btn) {
  try {
    const paths = await invoke("pick_files", { title: `选择上传到「${btn.dataset.nm}」的文件` });
    if (!paths || !paths.length) return;
    await invoke("upload_files", {
      url: `${SERVER}/api/projects/${pid}/files`,
      stageId: sid, itemId: iid, paths,
    });
    load();
  } catch (e) { alert("上传失败：" + errMsg(e)); }
}

function openApp() {
  if (SERVER) invoke("open_url", { url: SERVER + "/" });
}

/* ---------- 置顶 ---------- */

function renderPin() {
  const b = document.getElementById("btn-pin");
  b.classList.toggle("on", ON_TOP);
  b.title = ON_TOP ? "已置顶，点击取消置顶" : "未置顶，点击设为总是置顶";
}

async function togglePin() {
  ON_TOP = !ON_TOP;
  renderPin();
  try { await invoke("set_on_top", { on: ON_TOP }); } catch {}
}

/* ---------- 设置 ---------- */

function previewGlass() {
  const on = document.getElementById("ck-bg").checked;
  const alpha = parseInt(document.getElementById("op").value, 10) / 100;
  document.getElementById("opv").textContent = document.getElementById("op").value + "%";
  GLASS = { bg_transparent: on, glass_alpha: alpha };
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { invoke("set_glass", { on, alpha }).catch(() => {}); }, 120);
}

async function openSetup(isFirst) {
  firstRun = !!isFirst;
  try {
    const cfg = await invoke("get_config");
    SERVER = normServer(cfg.server);
    ON_TOP = !!cfg.on_top;
    GLASS = { bg_transparent: !!cfg.bg_transparent, glass_alpha: cfg.glass_alpha ?? 0.72 };
  } catch {}
  document.getElementById("setup-title").textContent = firstRun ? "📋 连接到项目进度服务器" : "挂件设置";
  document.getElementById("setup-hint").textContent = firstRun
    ? "数据库、文件与每日提醒都在服务端。\n填写服务端地址，例如 192.168.1.10:8300"
    : "";
  document.getElementById("su").value = SERVER;
  document.getElementById("ck-bg").checked = GLASS.bg_transparent;
  const op = document.getElementById("op");
  op.value = Math.round(GLASS.glass_alpha * 100);
  document.getElementById("opv").textContent = op.value + "%";
  document.getElementById("serr").textContent = "";
  document.getElementById("btn-close").textContent = firstRun ? "退出挂件" : "关闭";
  renderPin();
  document.getElementById("setup").classList.add("show");
}

function closeSetup() {
  if (firstRun) { quitApp(); return; }
  document.getElementById("setup").classList.remove("show");
}

async function saveSetup() {
  const err = document.getElementById("serr");
  const url = normServer(document.getElementById("su").value);
  const on = document.getElementById("ck-bg").checked;
  const alpha = parseInt(document.getElementById("op").value, 10) / 100;
  if (!url) { err.textContent = "服务器地址不能为空"; return; }
  err.textContent = "正在连接…";
  try {
    await invoke("check_server", { url });
  } catch (e) {
    err.textContent = "连接失败：请检查地址、端口以及服务端防火墙";
    return;
  }
  try {
    await invoke("set_server", { url });
    SERVER = url;
    await invoke("set_glass", { on, alpha });
    GLASS = { bg_transparent: on, glass_alpha: alpha };
  } catch (e) {
    err.textContent = "保存失败：" + errMsg(e);
    return;
  }
  err.textContent = "";
  document.getElementById("setup").classList.remove("show");
  firstRun = false;
  load();
}

function quitApp() {
  invoke("quit").catch(() => {});
}

/* ---------- 多列布局：宽度变化时只调列数，内容自动回流 ---------- */

window.addEventListener("resize", () => {
  const cols = Math.max(1, Math.min(3, Math.floor(document.body.clientWidth / 340)));
  if (cols !== lastCols) {
    lastCols = cols;
    document.getElementById("list").style.setProperty("--cols", cols);
  }
});

/* ---------- 启动 ---------- */

(async function init() {
  try {
    const cfg = await invoke("get_config");
    SERVER = normServer(cfg.server);
    ON_TOP = !!cfg.on_top;
    GLASS = { bg_transparent: !!cfg.bg_transparent, glass_alpha: cfg.glass_alpha ?? 0.72 };
  } catch {}
  renderPin();
  if (SERVER) load();
  else openSetup(true);
  setInterval(load, 60 * 1000);
})();
