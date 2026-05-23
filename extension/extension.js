const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const DAEMON_URL  = process.env.TEAM_CLAUDE_WS_URL  || "ws://localhost:7000/ws";
const ROOM_TOKEN  = process.env.TEAM_CLAUDE_TOKEN   || process.env.ROOM_TOKEN || "";
const SESSION_NAME = process.env.SESSION_NAME       || "session";

let ws = null;
let viewProvider = null;
let lastSnapshot = null;

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
      if (msg.kind === "hello" || msg.kind === "event") {
        if (msg.state)    lastSnapshot = msg.state;
        if (msg.snapshot) lastSnapshot = msg.snapshot;
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
      else if (msg.cmd === "ready" && lastSnapshot) {
        notifyView({ kind: "hello", state: lastSnapshot });
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
  input, select, textarea, button {
    font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    padding: 4px 6px; border-radius: 2px;
  }
  textarea { width: 100%; resize: vertical; min-height: 60px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; cursor: pointer; padding: 4px 10px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  h3 { font-size: 0.9rem; margin: 12px 0 4px; text-transform: uppercase; opacity: 0.6; }
  ul { list-style: none; padding: 0; margin: 0; }
  .status { font-size: 0.8em; opacity: 0.7; }
  .status.online  { color: var(--vscode-testing-iconPassed, #4ec9b0); }
  .status.offline { color: var(--vscode-testing-iconErrored, #f48771); }
  .feed li { margin: 4px 0; padding: 6px; background: var(--vscode-editorWidget-background); border-radius: 3px; }
  .feed .meta { font-size: 0.8em; opacity: 0.7; margin-bottom: 2px; }
  .feed .body { white-space: pre-wrap; }
  .participants li { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.active { background: var(--vscode-testing-iconQueued, #cca700); }
  .dot.done   { background: var(--vscode-testing-iconPassed, #4ec9b0); }
  .toolbar { display: flex; gap: 4px; margin: 8px 0; }
  .toolbar button { flex: 1; }
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

  <h3>Toi</h3>
  <div class="row">
    <label>Nom <input id="name"></label>
    <label>Rôle <input id="role"></label>
  </div>
  <label><input type="checkbox" id="hasMore" checked> j'ai encore des arguments</label>

  <h3>Contribuer</h3>
  <div class="row">
    <label>Type
      <select id="kind">
        <option value="argument">argument</option>
        <option value="objection">objection</option>
        <option value="question">question</option>
        <option value="constraint">contrainte</option>
        <option value="agreement">accord</option>
        <option value="clarification">clarification</option>
      </select>
    </label>
    <button onclick="sendMsg()">Envoyer</button>
  </div>
  <textarea id="body" placeholder="Ton message…"></textarea>

  <h3>Participants</h3>
  <ul id="participants" class="participants"><li class="status">(aucun)</li></ul>

  <h3>Messages récents</h3>
  <ul id="feed" class="feed"><li class="status">(aucun)</li></ul>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let speaker = vscode.getState()?.speaker || crypto.randomUUID();
  vscode.setState({ ...(vscode.getState()||{}), speaker });
  const saved = vscode.getState() || {};
  $("name").value = saved.name || "";
  $("role").value = saved.role || "";
  $("hasMore").checked = saved.hasMore ?? true;
  $("name").addEventListener("input", persist);
  $("role").addEventListener("input", persist);
  $("hasMore").addEventListener("change", () => { persist(); sendStatus(); });
  function persist() {
    vscode.setState({ speaker, name: $("name").value, role: $("role").value, hasMore: $("hasMore").checked });
  }
  function cmd(c) { vscode.postMessage({ cmd: c }); }
  function sendStatus() {
    vscode.postMessage({ cmd: "send", payload: {
      speaker, name: $("name").value, role: $("role").value,
      kind: "status", hasMoreArguments: $("hasMore").checked,
    }});
  }
  function sendMsg() {
    const body = $("body").value.trim();
    if (!body) return;
    vscode.postMessage({ cmd: "send", payload: {
      speaker, name: $("name").value, role: $("role").value,
      kind: $("kind").value, body, hasMoreArguments: $("hasMore").checked,
    }});
    $("body").value = "";
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function renderParticipants(list) {
    const ul = $("participants");
    if (!list?.length) { ul.innerHTML = '<li class="status">(aucun)</li>'; return; }
    ul.innerHTML = list.map(p =>
      \`<li><span class="dot \${p.hasMoreArguments ? "active" : "done"}"></span>
        <strong>\${escapeHtml(p.name)}</strong>
        \${p.role ? \`<span class="status">/ \${escapeHtml(p.role)}</span>\` : ""}</li>\`
    ).join("");
  }
  function appendEvent(ev) {
    if (!["argument","objection","question","constraint","agreement","clarification"].includes(ev.kind)) return;
    const ul = $("feed");
    const placeholder = ul.querySelector(".status"); if (placeholder) placeholder.remove();
    const li = document.createElement("li");
    li.innerHTML = \`<div class="meta"><strong>\${escapeHtml(ev.name||ev.speaker)}</strong>
      \${ev.role ? \`<span>/ \${escapeHtml(ev.role)}</span>\` : ""}
      <span>/ \${ev.kind}</span></div>
      <div class="body">\${escapeHtml(ev.body)}</div>\`;
    ul.prepend(li);
    while (ul.children.length > 30) ul.lastChild.remove();
  }
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.kind === "status") {
      $("status").textContent = msg.message;
      $("status").className = "status " + (msg.message === "connected" ? "online" : "offline");
    } else if (msg.kind === "hello" || msg.kind === "event") {
      const snap = msg.state || msg.snapshot;
      if (snap) renderParticipants(snap.participants);
      if (msg.ev) appendEvent(msg.ev);
    }
  });
  vscode.postMessage({ cmd: "ready" });
</script>
</body></html>`;
  }
}

module.exports = { activate, deactivate };
