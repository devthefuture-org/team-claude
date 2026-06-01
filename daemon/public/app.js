import { escapeHtml, formatTime } from "/util.js";
import { mountThemeToggle } from "/ui.js";

mountThemeToggle();

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");

const els = {
  status:        $("status"),
  sessionName:   $("session-name"),
  name:          $("name"),
  nameField:     $("name-field"),
  identityChip:  $("identity-chip"),
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
    // Pseudo is fixed by the invite — no need to ask for it again. Hide the
    // name field entirely and show who we're connected as instead.
    lockedPseudo = info.pseudo;
    els.name.value = info.pseudo;
    els.nameField.classList.add("hidden");
    els.identityChip.innerHTML = `Connecté·e en tant que <strong>${escapeHtml(info.pseudo)}</strong>`;
    els.identityChip.classList.remove("hidden");
  } else {
    lockedPseudo = null;
    els.nameField.classList.remove("hidden");
    els.identityChip.classList.add("hidden");
  }
}

// state: "online" | "offline" | "reconnecting"
function setStatus(state) {
  const label = { online: "online", offline: "offline", reconnecting: "reconnexion…" }[state];
  els.status.textContent = label;
  els.status.classList.toggle("status-online", state === "online");
  els.status.classList.toggle("status-offline", state === "offline");
  els.status.classList.toggle("status-pending", state === "reconnecting");
  els.sendBtn.disabled = state !== "online";
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
    li.innerHTML = renderToolEntry(entry);
  } else {
    return;
  }
  streamAppend(li);
}

function renderToolEntry(entry) {
  const head = `<div class="meta">${formatTime(entry.ts)} · 🔧 <span class="tool-name">${escapeHtml(entry.tool)}</span>${
    entry.summary ? ` <span class="tool-target">${escapeHtml(entry.summary)}</span>` : ""}</div>`;

  let params = "";
  if (Array.isArray(entry.params) && entry.params.length) {
    params = `<div class="tool-params">` + entry.params.map(p => {
      const val = p.block
        ? `<pre class="param-block">${escapeHtml(p.value)}</pre>`
        : `<span class="param-val${p.mono ? " mono" : ""}">${escapeHtml(p.value)}</span>`;
      return `<div class="tool-param"><span class="param-label">${escapeHtml(p.label)}</span>${val}</div>`;
    }).join("") + `</div>`;
  }

  let diff = "";
  if (Array.isArray(entry.diff) && entry.diff.length) {
    const sign = { add: "+", del: "-", ctx: " ", sep: "" };
    diff = `<pre class="diff">` + entry.diff.map(d =>
      d.t === "sep"
        ? `<span class="diff-line sep"> </span>`
        : `<span class="diff-line ${d.t}">${escapeHtml(sign[d.t] + " " + d.s)}</span>`
    ).join("") + `</pre>`;
  }

  return head + params + diff;
}

// Set when we send; the next matching echo from the daemon gets a brief
// highlight so the sender sees their message landed.
let pendingSelfEcho = false;

function isSelfEcho(ev) {
  return (lockedPseudo && ev.name === lockedPseudo) || ev.speaker === mySpeaker;
}

function appendParticipantEntry(ev) {
  if (!ev.body) return;
  const li = document.createElement("li");
  li.className = "participant";
  li.innerHTML = `<div class="meta">${formatTime(ev.ts)} · <strong>${escapeHtml(ev.name || ev.speaker)}</strong></div>
    <div class="body">${escapeHtml(ev.body)}</div>`;
  if (pendingSelfEcho && isSelfEcho(ev)) {
    li.classList.add("flash-sent");
    pendingSelfEcho = false;
  }
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
  ws.addEventListener("open",  () => setStatus("online"));
  ws.addEventListener("close", () => { setStatus("reconnecting"); setTimeout(connect, 2000); });
  ws.addEventListener("error", () => setStatus("reconnecting"));
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
  pendingSelfEcho = true;
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
