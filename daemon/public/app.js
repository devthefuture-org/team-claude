const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");

const els = {
  status:        $("status"),
  sessionName:   $("session-name"),
  name:          $("name"),
  body:          $("body"),
  sendBtn:       $("send-btn"),
  stream:        $("stream-list"),
  thinking:      $("thinking"),
  thinkingVerb:  document.querySelector(".thinking-verb"),
  thinkingDots:  document.querySelector(".thinking-dots"),
};

let ws = null;
let mySpeaker = localStorage.getItem("team-claude.speaker") || crypto.randomUUID();
localStorage.setItem("team-claude.speaker", mySpeaker);

// Identity: if the daemon issued us a participant token (via invite flow),
// hello.participantInfo carries the locked pseudo. Otherwise (host token) the
// name field stays free-form and is persisted in localStorage.
let lockedPseudo = null;

const savedName = localStorage.getItem("team-claude.name") || "";
els.name.value = savedName;
els.name.addEventListener("input", () => {
  if (!lockedPseudo) localStorage.setItem("team-claude.name", els.name.value);
});

function applyParticipantInfo(info) {
  if (info && info.pseudo) {
    lockedPseudo = info.pseudo;
    els.name.value = info.pseudo;
    els.name.readOnly = true;
    els.name.title = "Pseudo défini à l'acceptation de l'invitation — non modifiable.";
    const lbl = els.name.closest("label");
    if (lbl) lbl.firstChild.textContent = "Pseudo (verrouillé) ";
  } else {
    lockedPseudo = null;
    els.name.readOnly = false;
    els.name.title = "";
  }
}

function setOnline(online) {
  els.status.textContent = online ? "online" : "offline";
  els.status.classList.toggle("status-online", online);
  els.status.classList.toggle("status-offline", !online);
  els.sendBtn.disabled = !online;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

// ---------------------------------------------------------- Thinking spinner

const THINKING_VERBS = [
  "Réfléchit", "Cogite", "Médite", "Élucubre", "Mijote",
  "Lit", "Cherche", "Pèse", "Compose", "Tricote",
];
let thinkingTimer = null;
let dotsTimer = null;

function showThinking(on) {
  if (on) {
    els.thinking.classList.remove("hidden");
    rotateVerb();
    animateDots();
    if (!thinkingTimer) thinkingTimer = setInterval(rotateVerb, 2500);
    if (!dotsTimer)     dotsTimer     = setInterval(animateDots, 400);
  } else {
    els.thinking.classList.add("hidden");
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    if (dotsTimer)     { clearInterval(dotsTimer);     dotsTimer = null; }
  }
}
function rotateVerb() {
  els.thinkingVerb.textContent = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}
function animateDots() {
  const cur = els.thinkingDots.textContent;
  els.thinkingDots.textContent = cur.length >= 3 ? "" : cur + ".";
}

// ----------------------------------------------------------------- Stream

function clearStreamPlaceholder() {
  const ph = els.stream.querySelector(".muted");
  if (ph) ph.remove();
}

function streamAppend(li) {
  clearStreamPlaceholder();
  const atBottom = els.stream.scrollTop + els.stream.clientHeight >= els.stream.scrollHeight - 20;
  els.stream.appendChild(li);
  while (els.stream.children.length > 300) els.stream.firstChild.remove();
  if (atBottom) els.stream.scrollTop = els.stream.scrollHeight;
}

function appendClaudeEntry(entry) {
  const li = document.createElement("li");
  if (entry.role === "user") {
    li.className = "user";
    li.innerHTML = `<div class="meta">${formatTime(entry.ts)} · host</div>
      <div class="body">${escapeHtml(entry.text)}</div>`;
  } else if (entry.role === "assistant" && entry.text) {
    li.className = "assistant";
    li.innerHTML = `<div class="meta">${formatTime(entry.ts)} · Claude</div>
      <div class="body">${escapeHtml(entry.text)}</div>`;
  } else if (entry.role === "assistant" && entry.tool) {
    li.className = "tool";
    li.innerHTML = `<div class="meta">${formatTime(entry.ts)} · 🔧 ${escapeHtml(entry.tool)}</div>
      ${entry.summary ? `<div class="body">${escapeHtml(entry.summary)}</div>` : ""}`;
  } else {
    return;
  }
  streamAppend(li);
}

function appendParticipantEntry(ev) {
  if (!ev.body) return;
  const li = document.createElement("li");
  li.className = "participant";
  li.innerHTML = `<div class="meta">${formatTime(ev.ts)} · <strong>${escapeHtml(ev.name || ev.speaker)}</strong></div>
    <div class="body">${escapeHtml(ev.body)}</div>`;
  streamAppend(li);
}

function applyBacklog(claudeBacklog, participantBacklog) {
  els.stream.innerHTML = "";
  const merged = [
    ...(claudeBacklog || []).map(e => ({ kind: "claude", ts: e.ts, e })),
    ...(participantBacklog || []).map(e => ({ kind: "participant", ts: e.ts, e })),
  ].sort((a, b) => {
    const ta = Date.parse(a.ts) || 0;
    const tb = Date.parse(b.ts) || 0;
    return ta - tb;
  });
  if (!merged.length) {
    els.stream.innerHTML = '<li class="muted">(en attente d\'activité…)</li>';
    return;
  }
  for (const item of merged) {
    if (item.kind === "claude") appendClaudeEntry(item.e);
    else                        appendParticipantEntry(item.e);
  }
  els.stream.scrollTop = els.stream.scrollHeight;
}

function renderSnapshot(snap) {
  if (!snap) return;
  const count = snap.participants?.length ?? 0;
  els.sessionName.textContent = `session: ${snap.session} · ${count} participant(s)`;
}

// ----------------------------------------------------------------- WebSocket

function connect() {
  if (!TOKEN) {
    els.sessionName.textContent = "manque ?token=… dans l'URL";
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.addEventListener("open",  () => setOnline(true));
  ws.addEventListener("close", () => { setOnline(false); setTimeout(connect, 2000); });
  ws.addEventListener("error", () => setOnline(false));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    switch (msg.kind) {
      case "hello":
        renderSnapshot(msg.state);
        applyParticipantInfo(msg.participantInfo);
        applyBacklog(msg.claudeBacklog, msg.participantBacklog);
        showThinking(msg.claudeStatus?.state === "thinking");
        break;
      case "event":
        renderSnapshot(msg.snapshot);
        if (msg.ev) appendParticipantEntry(msg.ev);
        break;
      case "claude-event":
        if (msg.entry) appendClaudeEntry(msg.entry);
        break;
      case "claude-status":
        showThinking(msg.status?.state === "thinking");
        break;
      case "error":
        console.warn("daemon error:", msg.message);
        break;
    }
  });
}

function sendMessage() {
  const body = els.body.value.trim();
  if (!body) { els.body.focus(); return; }
  // For participant-token connections the daemon ignores speaker/name and
  // uses the server-side record (locked at invite acceptance). For host-token
  // connections (no participantInfo in hello) we still send the local UUID
  // and the user-typed name.
  const payload = lockedPseudo
    ? { body }
    : (() => {
        const name = els.name.value.trim();
        if (!name) { els.name.focus(); return null; }
        return { speaker: mySpeaker, name, body };
      })();
  if (!payload) return;
  ws?.send(JSON.stringify(payload));
  els.body.value = "";
  els.body.focus();
}

els.sendBtn.addEventListener("click", sendMessage);
els.body.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

connect();
