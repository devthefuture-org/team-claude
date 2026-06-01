const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const DAEMON_URL  = process.env.TEAM_CLAUDE_WS_URL  || "ws://localhost:7000/ws";
const ROOM_TOKEN  = process.env.TEAM_CLAUDE_TOKEN   || process.env.ROOM_TOKEN || "";
const SESSION_NAME = process.env.SESSION_NAME       || "session";

let ws = null;
let viewProvider = null;
let lastSnapshot     = null;
let lastClaudeBacklog = [];
let lastClaudeStatus  = { state: "idle" };
const CLAUDE_BACKLOG_MAX = 200;

function activate(context) {
  viewProvider = new TeamClaudePanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("team-claude.panel", viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("team-claude.openLive", openLiveMd),
    vscode.commands.registerCommand("team-claude.copyPromptInitial", copyPromptInitial),
    vscode.commands.registerCommand("team-claude.refresh", () => connect(true)),
  );
  connect();
}

function deactivate() {
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

function connect(force = false) {
  if (ws && !force) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (!ROOM_TOKEN) {
    notifyView({ kind: "status", message: "TEAM_CLAUDE_TOKEN / ROOM_TOKEN env var not set" });
    return;
  }
  const url = `${DAEMON_URL}?token=${encodeURIComponent(ROOM_TOKEN)}`;
  ws = new WebSocket(url);
  ws.on("open", () => notifyView({ kind: "status", message: "connected" }));
  ws.on("close", () => {
    notifyView({ kind: "status", message: "disconnected — reconnecting…" });
    setTimeout(() => connect(true), 3000);
  });
  ws.on("error", (e) => notifyView({ kind: "status", message: `ws error: ${e.message}` }));
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.kind === "hello") {
        if (msg.state)         lastSnapshot      = msg.state;
        if (msg.claudeBacklog) lastClaudeBacklog = msg.claudeBacklog;
        if (msg.claudeStatus)  lastClaudeStatus  = msg.claudeStatus;
      } else if (msg.kind === "event") {
        if (msg.snapshot) lastSnapshot = msg.snapshot;
      } else if (msg.kind === "claude-event" && msg.entry) {
        lastClaudeBacklog.push(msg.entry);
        while (lastClaudeBacklog.length > CLAUDE_BACKLOG_MAX) lastClaudeBacklog.shift();
      } else if (msg.kind === "claude-status" && msg.status) {
        lastClaudeStatus = msg.status;
      }
      notifyView(msg);
    } catch {}
  });
}

function notifyView(msg) {
  if (viewProvider?.view) viewProvider.view.webview.postMessage(msg);
}

function sendOnWs(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    notifyView({ kind: "status", message: "not connected" });
    return;
  }
  ws.send(JSON.stringify(payload));
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? "/workspace";
}

async function openLiveMd() {
  const live = path.join(workspaceRoot(), ".team-claude", "live.md");
  if (!fs.existsSync(live)) {
    vscode.window.showWarningMessage("team-claude: .team-claude/live.md introuvable");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(live);
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function copyPromptInitial() {
  const candidates = [
    path.join("/home/devbox", ".team-claude-prompt-initial.md"),
    path.join(workspaceRoot(), ".team-claude", "prompt-initial.md"),
  ];
  const src = candidates.find(p => fs.existsSync(p));
  if (!src) {
    vscode.window.showWarningMessage("team-claude: prompt initial introuvable");
    return;
  }
  await vscode.env.clipboard.writeText(fs.readFileSync(src, "utf8"));
  vscode.window.showInformationMessage("team-claude: prompt initial copié dans le presse-papiers");
}

class TeamClaudePanel {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.cmd === "send")        sendOnWs(msg.payload);
      else if (msg.cmd === "openLive") openLiveMd();
      else if (msg.cmd === "copyPrompt") copyPromptInitial();
      else if (msg.cmd === "ready") {
        // Replay the cached state so the view repopulates after a panel reopen.
        notifyView({
          kind:          "hello",
          state:         lastSnapshot,
          claudeBacklog: lastClaudeBacklog,
          claudeStatus:  lastClaudeStatus,
        });
      }
    });
  }

  getHtml() {
    const sessionName = SESSION_NAME;
    return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-sideBar-background); margin: 0; padding: 8px;
         font-size: var(--vscode-font-size); }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: 2px; flex: 1; }
  input, textarea, button {
    font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    padding: 4px 6px; border-radius: 3px;
  }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  textarea { width: 100%; resize: vertical; min-height: 60px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; cursor: pointer; padding: 4px 10px; transition: background-color .12s ease; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:active { opacity: 0.85; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  @keyframes sent-flash { from { box-shadow: 0 0 0 1px var(--vscode-testing-iconPassed, #4ec9b0); } to { box-shadow: 0 0 0 1px transparent; } }
  .flash-sent { animation: sent-flash .6s ease-out; }
  h3 { font-size: 0.85rem; margin: 12px 0 4px; text-transform: uppercase; opacity: 0.6; }
  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  .hidden { display: none !important; }
  .status { font-size: 0.8em; opacity: 0.7; }
  .status.online  { color: var(--vscode-testing-iconPassed, #4ec9b0); }
  .status.offline { color: var(--vscode-testing-iconErrored, #f48771); }
  .feed li { padding: 6px; background: var(--vscode-editorWidget-background); border-radius: 3px; }
  .feed .meta { font-size: 0.78em; opacity: 0.7; margin-bottom: 2px; }
  .feed .body { white-space: pre-wrap; }
  .toolbar { display: flex; gap: 4px; margin: 8px 0; }
  .toolbar button { flex: 1; }

  /* Stream */
  #stream { max-height: 45vh; overflow-y: auto; padding: 2px; }
  #stream li { padding: 5px 7px; border-radius: 6px; max-width: 95%; word-wrap: break-word;
               background: var(--vscode-editorWidget-background); }
  #stream li.user      { align-self: flex-end;  background: var(--vscode-inputOption-activeBackground, var(--vscode-editorWidget-background)); }
  #stream li.assistant { align-self: flex-start; background: var(--vscode-editorInfo-background, var(--vscode-editorWidget-background)); }
  #stream li.tool      { align-self: flex-start; font-family: var(--vscode-editor-font-family); font-size: 0.83em; opacity: 0.8; border: 1px dashed var(--vscode-widget-border, transparent); }
  #stream .meta { font-size: 0.7em; opacity: 0.6; margin-bottom: 2px; }
  #stream .body { white-space: pre-wrap; }
  #stream .tool .tool-name { color: var(--vscode-charts-orange, #cca700); font-weight: 600; }

  /* Thinking indicator */
  .thinking { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 0.85em; opacity: 0.8; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 11px; height: 11px;
             border: 2px solid var(--vscode-progressBar-background, #ccc); border-top-color: var(--vscode-charts-orange, #cca700);
             border-radius: 50%; animation: spin 0.8s linear infinite; }
</style>
</head><body>
  <div class="row">
    <strong>${sessionName}</strong>
    <span class="status offline" id="status">offline</span>
  </div>

  <div class="toolbar">
    <button onclick="cmd('openLive')">live.md</button>
    <button onclick="cmd('copyPrompt')">prompt</button>
  </div>

  <h3>Claude</h3>
  <ul id="stream"><li class="status">(en attente…)</li></ul>
  <div id="thinking" class="thinking hidden">
    <span class="spinner"></span>
    <span class="verb">Réfléchit</span><span class="dots">…</span>
  </div>

  <h3>Drop un message</h3>
  <div class="row">
    <label>Nom <input id="name"></label>
    <button onclick="sendMsg()">Envoyer</button>
  </div>
  <textarea id="body" placeholder="Ton message… (Ctrl/Cmd+Entrée)"></textarea>

  <h3>Messages participants</h3>
  <ul id="feed" class="feed"><li class="status">(aucun)</li></ul>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let speaker = vscode.getState()?.speaker || crypto.randomUUID();
  const saved  = vscode.getState() || {};
  vscode.setState({ ...saved, speaker });
  $("name").value = saved.name || "";
  $("name").addEventListener("input", () => {
    vscode.setState({ ...vscode.getState(), name: $("name").value });
  });
  function cmd(c) { vscode.postMessage({ cmd: c }); }
  let pendingSelfEcho = false;
  function sendMsg() {
    const body = $("body").value.trim();
    const name = $("name").value.trim();
    if (!body || !name) return;
    vscode.postMessage({ cmd: "send", payload: { speaker, name, body } });
    pendingSelfEcho = true;
    $("body").value = "";
    $("body").focus();
  }
  $("body").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); sendMsg(); }
  });
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function formatTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}); } catch { return ""; }
  }

  const VERBS = ["Réfléchit","Cogite","Médite","Élucubre","Mijote","Lit","Cherche","Pèse","Compose","Tricote"];
  let verbTimer = null, dotsTimer = null;
  function showThinking(on) {
    const t = $("thinking");
    if (on) {
      t.classList.remove("hidden");
      if (!verbTimer) verbTimer = setInterval(() => { t.querySelector(".verb").textContent = VERBS[Math.floor(Math.random()*VERBS.length)]; }, 2500);
      if (!dotsTimer) dotsTimer = setInterval(() => {
        const d = t.querySelector(".dots"); d.textContent = d.textContent.length >= 3 ? "" : d.textContent + ".";
      }, 400);
    } else {
      t.classList.add("hidden");
      clearInterval(verbTimer); clearInterval(dotsTimer); verbTimer = dotsTimer = null;
    }
  }

  function clearStreamPlaceholder() {
    const ph = $("stream").querySelector(".status"); if (ph) ph.remove();
  }
  function appendStream(entry) {
    clearStreamPlaceholder();
    const ul = $("stream");
    const li = document.createElement("li");
    if (entry.role === "user") {
      li.className = "user";
      li.innerHTML = \`<div class="meta">\${formatTime(entry.ts)} · host</div><div class="body">\${escapeHtml(entry.text)}</div>\`;
    } else if (entry.role === "assistant" && entry.text) {
      li.className = "assistant";
      li.innerHTML = \`<div class="meta">\${formatTime(entry.ts)} · Claude</div><div class="body">\${escapeHtml(entry.text)}</div>\`;
    } else if (entry.role === "assistant" && entry.tool) {
      li.className = "tool";
      li.innerHTML = \`<div class="body"><span class="tool-name">🔧 \${escapeHtml(entry.tool)}</span>\${entry.summary ? " " + escapeHtml(entry.summary) : ""}</div>\`;
    } else return;
    const atBottom = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 20;
    ul.appendChild(li);
    while (ul.children.length > 200) ul.firstChild.remove();
    if (atBottom) ul.scrollTop = ul.scrollHeight;
  }
  function applyBacklog(backlog) {
    const ul = $("stream"); ul.innerHTML = "";
    if (!backlog?.length) { ul.innerHTML = '<li class="status">(en attente d\\'une réponse de Claude…)</li>'; return; }
    for (const e of backlog) appendStream(e);
    ul.scrollTop = ul.scrollHeight;
  }

  function appendParticipant(ev) {
    if (!ev.body) return;
    const ul = $("feed");
    const placeholder = ul.querySelector(".status"); if (placeholder) placeholder.remove();
    const li = document.createElement("li");
    li.innerHTML = \`<div class="meta"><strong>\${escapeHtml(ev.name||ev.speaker)}</strong>
      <span>· \${formatTime(ev.ts)}</span></div>
      <div class="body">\${escapeHtml(ev.body)}</div>\`;
    if (pendingSelfEcho && ev.speaker === speaker) { li.classList.add("flash-sent"); pendingSelfEcho = false; }
    ul.prepend(li);
    while (ul.children.length > 30) ul.lastChild.remove();
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.kind) {
      case "status":
        $("status").textContent = msg.message;
        $("status").className = "status " + (msg.message === "connected" ? "online" : "offline");
        break;
      case "hello":
        applyBacklog(msg.state?.claudeBacklog || msg.claudeBacklog);
        showThinking((msg.state?.claudeStatus || msg.claudeStatus)?.state === "thinking");
        break;
      case "event":
        if (msg.ev) appendParticipant(msg.ev);
        break;
      case "claude-event":
        if (msg.entry) appendStream(msg.entry);
        break;
      case "claude-status":
        showThinking(msg.status?.state === "thinking");
        break;
    }
  });
  vscode.postMessage({ cmd: "ready" });
</script>
</body></html>`;
  }
}

module.exports = { activate, deactivate };
