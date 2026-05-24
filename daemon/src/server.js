import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { startClaudeStream } from "./claude-stream.js";
import { findOAuthCallbackPort, proxyToLocalhost } from "./oauth-proxy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

const PORT               = Number(process.env.PORT ?? 7000);
const WS_PATH            = process.env.WS_PATH            ?? "/ws";
const HEALTH_PATH        = process.env.HEALTH_PATH        ?? "/healthz";
const WORKSPACE_DIR      = process.env.WORKSPACE_DIR      ?? "/workspace";
const SESSION_NAME       = process.env.SESSION_NAME       ?? "default";
const ROOM_TOKEN         = process.env.ROOM_TOKEN         ?? "";
// The chart mounts the .claude subPath of the PVC here (read-only) so the
// daemon can tail Claude Code's session transcripts without seeing the rest
// of the devbox home directory.
const CLAUDE_CONFIG_DIR  = process.env.CLAUDE_CONFIG_DIR  ?? "/claude-data";
// Path Claude was invoked from in the devcontainer — used to compute the
// project dir key (slashes → dashes), e.g. /home/devbox/workspace → -home-devbox-workspace.
const CLAUDE_WORKSPACE   = process.env.CLAUDE_WORKSPACE   ?? "/home/devbox/workspace";

const STATE_DIR    = join(WORKSPACE_DIR, ".team-claude");
const EVENTS_FILE  = join(STATE_DIR, "events.jsonl");
const LIVE_FILE    = join(STATE_DIR, "live.md");
const STATE_FILE   = join(STATE_DIR, "state.json");
const INVITES_FILE      = join(STATE_DIR, "invites.json");
const PARTICIPANTS_FILE = join(STATE_DIR, "participants.json");
const CLAUDE_MD    = join(WORKSPACE_DIR, "CLAUDE.md");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

if (!ROOM_TOKEN) {
  console.warn("[team-claude-host] WARNING: ROOM_TOKEN not set — daemon will reject all WS connections");
}

const state = {
  participants: new Map(), // speakerId -> { id, name, lastSeenAt }
  lastSeq: 0,
  lastMessageAt: null,
};

// Rolling buffer of claude transcript events so newcomers see the
// in-progress conversation when they connect.
const claudeBuffer = [];
const CLAUDE_BUFFER_MAX = 200;
// Dedup set keyed in sync with claudeBuffer — protects against
// `tail -F` respawn / Claude session rotation re-emitting old entries.
const seenClaudeKeys = new Set();
// Mirror buffer of recent participant events so late-joiners can see the
// drop history interleaved with the claude transcript by timestamp.
const participantBuffer = [];
const PARTICIPANT_BUFFER_MAX = 50;
let claudeStatus = { state: "idle", since: null };

const wsClients = new Set();

// Single-writer queue for participant ingestion so that seq allocation,
// disk persistence, regeneration and broadcast happen in strict order
// even when multiple clients send messages concurrently.
let writeChain = Promise.resolve();
function serialize(task) {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => {});
  return next;
}

// ─── Invite codes & per-participant tokens ───────────────────────────────
// invites:      one-shot codes minted by the host (via tcl invite). Opening
//               the URL lets the participant pick a pseudo once and yields
//               their personal token. Codes don't expire; consuming one is
//               the only way to invalidate it (or `tcl revoke-invite`).
// participants: { token, speaker, pseudo, joinedAt, lastSeenAt, revokedAt }
//               Tokens don't expire; revocation is explicit (`tcl revoke`).
const invites      = new Map(); // code → record
const participants = new Map(); // token → record

function randomCode()  { return randomBytes(9).toString("base64url"); }   // 12 chars
function randomToken() { return randomBytes(24).toString("base64url"); }  // 32 chars

async function loadInvites() {
  if (!existsSync(INVITES_FILE)) return;
  try {
    const data = JSON.parse(await readFile(INVITES_FILE, "utf8"));
    for (const inv of data.invites ?? []) invites.set(inv.code, inv);
  } catch (e) { console.error("[team-claude-host] bad invites.json:", e.message); }
}

async function persistInvites() {
  await writeAtomic(INVITES_FILE, JSON.stringify({ invites: [...invites.values()] }, null, 2));
}

async function loadParticipants() {
  if (!existsSync(PARTICIPANTS_FILE)) return;
  try {
    const data = JSON.parse(await readFile(PARTICIPANTS_FILE, "utf8"));
    for (const p of data.participants ?? []) participants.set(p.token, p);
  } catch (e) { console.error("[team-claude-host] bad participants.json:", e.message); }
}

async function persistParticipants() {
  // Persist the full record (token included). The file is only readable
  // inside the pod (PVC, restricted security context).
  await writeAtomic(PARTICIPANTS_FILE, JSON.stringify({ participants: [...participants.values()] }, null, 2));
}

function findParticipantByToken(token) {
  if (!token) return null;
  const p = participants.get(token);
  return p && !p.revokedAt ? p : null;
}

function findParticipantByPseudo(pseudo) {
  for (const p of participants.values()) {
    if (p.pseudo === pseudo && !p.revokedAt) return p;
  }
  return null;
}

function authenticate(token) {
  if (!token) return null;
  if (ROOM_TOKEN && token === ROOM_TOKEN) return { kind: "host" };
  const p = findParticipantByToken(token);
  if (p) return { kind: "participant", record: p };
  return null;
}

async function ensureStateDir() {
  await mkdir(STATE_DIR, { recursive: true });
  if (existsSync(EVENTS_FILE)) await replayEvents();
  await loadInvites();
  await loadParticipants();
  console.log(`[team-claude-host] loaded ${invites.size} invite(s), ${participants.size} participant(s)`);
}

async function replayEvents() {
  const data = await readFile(EVENTS_FILE, "utf8").catch(() => "");
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      applyEvent(JSON.parse(line));
    } catch (e) {
      console.error("[team-claude-host] bad event line:", e.message);
    }
  }
  console.log(`[team-claude-host] replayed up to seq=${state.lastSeq}, participants=${state.participants.size}`);
}

function applyEvent(ev) {
  state.lastSeq = Math.max(state.lastSeq, ev.seq ?? 0);
  if (ev.ts) state.lastMessageAt = ev.ts;
  if (ev.body) {
    participantBuffer.push(ev);
    while (participantBuffer.length > PARTICIPANT_BUFFER_MAX) participantBuffer.shift();
  }
  if (!ev.speaker) return;
  state.participants.set(ev.speaker, {
    id:         ev.speaker,
    name:       ev.name || ev.speaker,
    lastSeenAt: ev.ts || state.lastMessageAt,
  });
}

async function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function persistEvent(ev) {
  await appendFile(EVENTS_FILE, JSON.stringify(ev) + "\n");
}

function formatTime(ts) {
  try { return new Date(ts).toISOString().slice(11, 19) + "Z"; }
  catch { return ts ?? ""; }
}

async function regenerateLive() {
  const recent = await tailEvents(30);
  const lines = [];
  lines.push("# Session collaborative", "");
  lines.push(`_Session : ${SESSION_NAME} — ${state.participants.size} participant(s), ${state.lastSeq} message(s)_`, "");
  if (!recent.length) {
    lines.push("(aucun message pour l'instant)", "");
  } else {
    for (const ev of recent) {
      if (!ev.body) continue;
      lines.push(`### ${ev.name || ev.speaker} — ${formatTime(ev.ts)}`, "", ev.body, "");
    }
  }
  await writeAtomic(LIVE_FILE, lines.join("\n"));
}

async function tailEvents(n) {
  if (!existsSync(EVENTS_FILE)) return [];
  const data = await readFile(EVENTS_FILE, "utf8");
  const lines = data.split("\n").filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function regenerateState() {
  const snapshot = {
    session:       SESSION_NAME,
    participants:  [...state.participants.values()],
    lastSeq:       state.lastSeq,
    lastMessageAt: state.lastMessageAt,
  };
  await writeAtomic(STATE_FILE, JSON.stringify(snapshot, null, 2));
}

const CLAUDE_MD_CONTENT = `# team-claude — session collaborative

Tu participes à une session de **vibe coding à plusieurs**. Des participants
humains déposent des messages courts dans \`.team-claude/events.jsonl\` (JSONL
append-only). Pour les recevoir en temps réel :

**Au tout premier message de chaque session, lance un Monitor :**

\`\`\`bash
tail -F .team-claude/events.jsonl
\`\`\`

Le Monitor te livre chaque nouvelle ligne JSON comme une notification mid-conversation.
Parse le JSON (\`{seq, speaker, name, body, ts}\`) et intègre le message à ta
réflexion en cours. Tu n'as PAS besoin que le host te dise "relis live.md" — tu vois
les messages arriver tout seul.

## Comportement attendu

- **Drop naturel** : les messages sont des contributions libres, pas des instructions
  formelles. Distingue qui parle (\`name\`) mais ne traite pas chaque message comme
  une demande de validation.
- **Cite explicitement le nom du participant** quand tu intègres son message
  ("Alice suggère X", "Bob conteste avec Y") — c'est important pour que les
  autres participants suivent qui a dit quoi dans la conversation visible côté
  team-claude.
- **Intègre puis avance** : par défaut, prends en compte le nouveau message et continue
  l'action en cours.
- **Pause si contradiction** : si un nouveau message contredit une décision en cours
  ou ce que tu es en train de faire :
  1. Termine l'étape atomique en cours (n'arrête pas un edit à mi-chemin).
  2. Résume la contradiction en une phrase ("X dit A, Y dit B — pas d'accord sur Z").
  3. Pose 1-2 questions ouvertes pour faire émerger un consensus.
  4. Attends une réponse avant de trancher.
- **Brainstorm, explique, challenge** quand c'est utile — pas besoin d'attendre une
  demande explicite. Sois un facilitateur, pas un exécutant silencieux.
- **Ne force pas le consensus artificiel** : si les positions restent incompatibles
  après discussion, propose un trade-off ou un essai réversible plutôt que d'imposer.
- **Le host garde le contrôle final** sur les commits, pushs, et actions destructives.

## Fichiers d'état

- \`.team-claude/events.jsonl\` — journal brut append-only. **Source de vérité** pour Monitor.
- \`.team-claude/live.md\` — vue lisible générée par le daemon (utile si tu perds le contexte).
- \`.team-claude/state.json\` — qui a parlé récemment, lastSeq.
`;

async function ensureClaudeMd() {
  if (existsSync(CLAUDE_MD)) return;
  try {
    await writeAtomic(CLAUDE_MD, CLAUDE_MD_CONTENT);
    console.log(`[team-claude-host] wrote ${CLAUDE_MD}`);
  } catch (e) {
    console.warn(`[team-claude-host] could not write ${CLAUDE_MD}: ${e.message}`);
  }
}

async function handleIncoming(raw, auth) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { error: "invalid_json" }; }
  if (!msg.body || typeof msg.body !== "string") return { error: "missing_body" };

  // For participant-token connections the identity is fixed server-side
  // (one-time pseudo selected at invite consumption). For host-token
  // connections we trust the client-supplied speaker/name as before.
  let speaker, name;
  if (auth?.kind === "participant") {
    speaker = auth.record.speaker;
    name    = auth.record.pseudo;
    auth.record.lastSeenAt = new Date().toISOString();
    persistParticipants().catch(e => console.error("[team-claude-host] persistParticipants:", e.message));
  } else {
    if (!msg.speaker || typeof msg.speaker !== "string") return { error: "missing_speaker" };
    speaker = msg.speaker.slice(0, 64);
    name    = (msg.name ?? "").slice(0, 64) || msg.speaker.slice(0, 8);
  }

  const ev = {
    seq:     state.lastSeq + 1,
    speaker,
    name,
    body:    msg.body.trim().slice(0, 4000),
    ts:      new Date().toISOString(),
  };

  applyEvent(ev);
  await persistEvent(ev);
  await regenerateLive();
  await regenerateState();
  return { ok: true, ev };
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let data = "", n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) { req.destroy(); reject(new Error("body too large")); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderInvitePage({ code, sessionName, error, pseudo }) {
  return `<!doctype html>
<html lang="fr" style="background:#111;color:#e5e5e5">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>team-claude — invitation ${htmlEscape(sessionName)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1>team-claude</h1><span class="muted">invitation · session ${htmlEscape(sessionName)}</span></header>
<main>
  <section>
    <h2>Choisis ton pseudo</h2>
    <p class="muted" style="margin-top:0">Une fois rejoint·e, ton pseudo est fixe pour cette session. Choisis bien.</p>
    ${error ? `<p style="color:var(--err)">${htmlEscape(error)}</p>` : ""}
    <form method="POST" action="/invite/${htmlEscape(code)}" autocomplete="off">
      <div class="row">
        <label>Pseudo
          <input name="pseudo" required minlength="1" maxlength="32" autofocus value="${htmlEscape(pseudo ?? "")}" placeholder="Alice">
        </label>
        <button type="submit">Rejoindre</button>
      </div>
    </form>
  </section>
</main>
</body>
</html>`;
}

function renderErrorPage({ sessionName, title, message }) {
  return `<!doctype html>
<html lang="fr" style="background:#111;color:#e5e5e5">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>team-claude — ${htmlEscape(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1>team-claude</h1><span class="muted">session ${htmlEscape(sessionName)}</span></header>
<main><section>
  <h2 style="color:var(--err)">${htmlEscape(title)}</h2>
  <p>${htmlEscape(message)}</p>
</section></main>
</body>
</html>`;
}

function requireAdmin(req, res) {
  const url = new URL(req.url, "http://x");
  const tok = url.searchParams.get("token");
  if (!ROOM_TOKEN || tok !== ROOM_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

async function safeServeStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const safe = normalize(urlPath).replace(/^(\.\.[\\/])+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// Ports owned by other pod-local services that the OAuth proxy must skip
// when auto-discovering the claude CLI's ephemeral callback listener.
const RESERVED_LOCAL_PORTS = new Set([
  PORT,    // ourselves
  8080,    // code-server
  2222,    // sshd (when ssh.enabled)
  22,
]);

const server = createServer(async (req, res) => {
  if (req.url.startsWith(HEALTH_PATH)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", session: SESSION_NAME, lastSeq: state.lastSeq }));
    return;
  }
  if (req.url === "/session.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ session: SESSION_NAME, wsPath: WS_PATH }));
    return;
  }
  // OAuth callback proxy: claude (and similar) opens a localhost callback
  // server on a random port; rewrite the host portion of the redirect URL
  // to this daemon's public URL and we relay to the actual port. The port
  // is auto-discovered by scanning /proc/net/tcp for ephemeral listeners,
  // or can be supplied explicitly via ?_port=<n>.
  if (req.url.startsWith("/callback")) {
    const url = new URL(req.url, "http://x");
    let port = parseInt(url.searchParams.get("_port") ?? "", 10);
    if (port) {
      // Strip the hint from the upstream URL so the CLI server doesn't see it.
      url.searchParams.delete("_port");
      req.url = url.pathname + (url.search ? "?" + url.searchParams.toString() : "");
    } else {
      port = await findOAuthCallbackPort({ reservedPorts: RESERVED_LOCAL_PORTS });
    }
    if (!port) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("oauth-proxy: no localhost callback server detected.\n"
        + "If `claude` is currently waiting on an OAuth callback, retry with\n"
        + "  /callback?...&_port=<port>\n"
        + "where <port> is the localhost port shown in the terminal URL.\n");
      return;
    }
    console.log(`[team-claude-host/oauth-proxy] relaying ${req.method} ${req.url} → 127.0.0.1:${port}`);
    proxyToLocalhost(port, req, res);
    return;
  }

  // ── Invite flow ──────────────────────────────────────────────────────
  // GET  /invite/<code>: serve the one-time pseudo-selection form.
  // POST /invite/<code>: consume the code, create a participant record,
  // 302 to / with the new participant token.
  if (req.url.startsWith("/invite/")) {
    const url = new URL(req.url, "http://x");
    const code = url.pathname.slice("/invite/".length);
    const invite = invites.get(code);
    if (!invite) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation inconnue", message: "Ce code d'invitation n'existe pas (ou plus). Demande au host de t'en envoyer un nouveau." }));
      return;
    }
    if (invite.consumedAt) {
      res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation déjà utilisée", message: `Ce code a déjà été consommé par ${invite.consumedBy} le ${invite.consumedAt}. Demande au host un nouveau code.` }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderInvitePage({ code, sessionName: SESSION_NAME }));
      return;
    }
    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch { res.writeHead(413).end("body too large"); return; }
      const params = new URLSearchParams(body);
      const pseudo = (params.get("pseudo") ?? "").trim().slice(0, 32);
      if (!pseudo) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderInvitePage({ code, sessionName: SESSION_NAME, error: "Pseudo requis.", pseudo }));
        return;
      }
      if (findParticipantByPseudo(pseudo)) {
        res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderInvitePage({ code, sessionName: SESSION_NAME, error: `Le pseudo « ${pseudo} » est déjà pris. Choisis-en un autre.`, pseudo }));
        return;
      }
      // Race-safe consume: re-check inside the serialize() queue so two
      // concurrent submits on the same code can't both succeed.
      const consumed = await serialize(async () => {
        const inv = invites.get(code);
        if (!inv || inv.consumedAt) return null;
        if (findParticipantByPseudo(pseudo)) return { error: "pseudo_taken" };
        const record = {
          token:      randomToken(),
          speaker:    randomUUID(),
          pseudo,
          joinedAt:   new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          revokedAt:  null,
          fromInvite: code,
        };
        inv.consumedAt = record.joinedAt;
        inv.consumedBy = pseudo;
        participants.set(record.token, record);
        await persistInvites();
        await persistParticipants();
        return { record };
      });
      if (!consumed) {
        res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation déjà utilisée", message: "Ce code vient d'être consommé." }));
        return;
      }
      if (consumed.error === "pseudo_taken") {
        res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderInvitePage({ code, sessionName: SESSION_NAME, error: `Le pseudo « ${pseudo} » vient d'être pris. Choisis-en un autre.`, pseudo }));
        return;
      }
      const location = `/?token=${encodeURIComponent(consumed.record.token)}`;
      res.writeHead(302, { "Location": location, "Content-Type": "text/plain" });
      res.end(`Redirecting to ${location}`);
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  // ── Admin endpoints (gated by ROOM_TOKEN query param) ────────────────
  if (req.url.startsWith("/admin/")) {
    if (!requireAdmin(req, res)) return;
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/admin/invite") {
      const inv = { code: randomCode(), createdAt: new Date().toISOString(), consumedAt: null, consumedBy: null };
      invites.set(inv.code, inv);
      await persistInvites();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: inv.code, createdAt: inv.createdAt }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/invites") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ invites: [...invites.values()] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/participants") {
      // Strip tokens before returning — the host already has the room token,
      // they don't need to know each participant's bearer.
      const safe = [...participants.values()].map(p => ({
        speaker: p.speaker, pseudo: p.pseudo, joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt, revokedAt: p.revokedAt, fromInvite: p.fromInvite,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ participants: safe }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/revoke") {
      let body;
      try { body = await readBody(req); } catch { res.writeHead(413).end("body too large"); return; }
      const params = new URLSearchParams(body);
      const pseudo = (params.get("pseudo") ?? "").trim();
      const target = findParticipantByPseudo(pseudo);
      if (!target) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_active_participant_with_that_pseudo", pseudo }));
        return;
      }
      target.revokedAt = new Date().toISOString();
      await persistParticipants();
      // Kick any open WS belonging to this participant.
      for (const ws of wsClients) {
        if (ws._auth?.kind === "participant" && ws._auth.record === target) {
          try { ws.close(4001, "revoked"); } catch {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pseudo, revokedAt: target.revokedAt }));
      return;
    }
    res.writeHead(404).end("not found");
    return;
  }

  await safeServeStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== WS_PATH) { socket.destroy(); return; }
  const auth = authenticate(url.searchParams.get("token"));
  if (!auth) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._auth = auth;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.send(JSON.stringify({
    kind:               "hello",
    state:              snapshotForClient(),
    claudeBacklog:      claudeBuffer,
    participantBacklog: participantBuffer,
    claudeStatus,
    participantInfo:    ws._auth.kind === "participant"
      ? { pseudo: ws._auth.record.pseudo, joinedAt: ws._auth.record.joinedAt }
      : null,
  }));

  ws.on("message", (raw) => {
    serialize(async () => {
      const result = await handleIncoming(raw.toString(), ws._auth);
      if (result.error) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: "error", message: result.error }));
        return;
      }
      broadcast({ kind: "event", ev: result.ev, snapshot: snapshotForClient() });
    });
  });
});

function snapshotForClient() {
  return {
    session:       SESSION_NAME,
    participants:  [...state.participants.values()],
    lastSeq:       state.lastSeq,
    lastMessageAt: state.lastMessageAt,
  };
}

function claudeKey(entry) {
  return `${entry.ts ?? ""}|${entry.role ?? ""}|${entry.text ?? ""}|${entry.tool ?? ""}|${entry.summary ?? ""}`;
}

function pushClaude(entry) {
  const k = claudeKey(entry);
  if (seenClaudeKeys.has(k)) return;
  seenClaudeKeys.add(k);
  claudeBuffer.push(entry);
  while (claudeBuffer.length > CLAUDE_BUFFER_MAX) {
    const removed = claudeBuffer.shift();
    seenClaudeKeys.delete(claudeKey(removed));
  }
  broadcast({ kind: "claude-event", entry });
}

function setClaudeStatus(status) {
  claudeStatus = status;
  broadcast({ kind: "claude-status", status });
}

await ensureStateDir();
await ensureClaudeMd();

const stopClaudeStream = startClaudeStream({
  workspaceDir:    CLAUDE_WORKSPACE,
  claudeConfigDir: CLAUDE_CONFIG_DIR,
  onEvent:  pushClaude,
  onStatus: setClaudeStatus,
  log:      (m) => console.log(`[team-claude-host/stream] ${m}`),
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[team-claude-host] session=${SESSION_NAME} listening on :${PORT} ws=${WS_PATH}`);
});

const shutdown = (sig) => () => {
  console.log(`[team-claude-host] ${sig} received, shutting down`);
  stopClaudeStream();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT",  shutdown("SIGINT"));
