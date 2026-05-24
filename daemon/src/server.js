import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

async function ensureStateDir() {
  await mkdir(STATE_DIR, { recursive: true });
  if (existsSync(EVENTS_FILE)) await replayEvents();
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

async function handleIncoming(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { error: "invalid_json" }; }
  if (!msg.speaker || typeof msg.speaker !== "string") return { error: "missing_speaker" };
  if (!msg.body    || typeof msg.body    !== "string") return { error: "missing_body" };

  const ev = {
    seq:     state.lastSeq + 1,
    speaker: msg.speaker.slice(0, 64),
    name:    (msg.name ?? "").slice(0, 64) || msg.speaker.slice(0, 8),
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
  await safeServeStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== WS_PATH) { socket.destroy(); return; }
  const token = url.searchParams.get("token");
  if (!ROOM_TOKEN || token !== ROOM_TOKEN) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.send(JSON.stringify({
    kind:           "hello",
    state:          snapshotForClient(),
    claudeBacklog:  claudeBuffer,
    claudeStatus,
  }));

  ws.on("message", (raw) => {
    serialize(async () => {
      const result = await handleIncoming(raw.toString());
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
