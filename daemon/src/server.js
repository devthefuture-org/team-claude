import { createServer } from "node:http";
import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

const PORT          = Number(process.env.PORT          ?? 7000);
const WS_PATH       = process.env.WS_PATH       ?? "/ws";
const HEALTH_PATH   = process.env.HEALTH_PATH   ?? "/healthz";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/workspace";
const SESSION_NAME  = process.env.SESSION_NAME  ?? "default";
const ROOM_TOKEN    = process.env.ROOM_TOKEN    ?? "";

const STATE_DIR     = join(WORKSPACE_DIR, ".team-claude");
const EVENTS_FILE   = join(STATE_DIR, "events.jsonl");
const LIVE_FILE     = join(STATE_DIR, "live.md");
const STATE_FILE    = join(STATE_DIR, "state.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

const VALID_KINDS = new Set([
  "argument", "objection", "question", "constraint", "agreement", "clarification",
]);

if (!ROOM_TOKEN) {
  console.warn("[team-claude-host] WARNING: ROOM_TOKEN not set — daemon will reject all WS connections");
}

const state = {
  topic: `Session ${SESSION_NAME}`,
  phase: "open",
  participants: new Map(), // id -> { id, name, role, hasMoreArguments }
  lastSeq: 0,
};

const wsClients = new Set();

async function ensureStateDir() {
  await mkdir(STATE_DIR, { recursive: true });
  if (existsSync(EVENTS_FILE)) await replayEvents();
}

async function replayEvents() {
  const data = await readFile(EVENTS_FILE, "utf8").catch(() => "");
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      applyEvent(ev, { persist: false });
    } catch (e) {
      console.error("[team-claude-host] bad event line:", e.message);
    }
  }
  console.log(`[team-claude-host] replayed up to seq=${state.lastSeq}, participants=${state.participants.size}`);
}

function applyEvent(ev, { persist = true } = {}) {
  state.lastSeq = Math.max(state.lastSeq, ev.seq ?? 0);

  if (ev.kind === "join" || ev.kind === "presence") {
    state.participants.set(ev.speaker, {
      id:               ev.speaker,
      name:             ev.name ?? ev.speaker,
      role:             ev.role ?? "",
      hasMoreArguments: ev.hasMoreArguments ?? true,
    });
  } else if (ev.kind === "status") {
    const p = state.participants.get(ev.speaker);
    if (p) p.hasMoreArguments = ev.hasMoreArguments;
  } else if (VALID_KINDS.has(ev.kind)) {
    if (!state.participants.has(ev.speaker)) {
      state.participants.set(ev.speaker, {
        id: ev.speaker, name: ev.name ?? ev.speaker, role: ev.role ?? "",
        hasMoreArguments: true,
      });
    }
  }
}

async function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function persistEvent(ev) {
  await appendFile(EVENTS_FILE, JSON.stringify(ev) + "\n");
}

async function regenerateLive() {
  const participants = [...state.participants.values()];
  const recent = await tailEvents(20);

  const lines = [];
  lines.push("# Session collaborative", "");
  lines.push(`## Sujet courant`, "", state.topic, "");
  lines.push("## État des participants", "");
  if (!participants.length) lines.push("- (aucun participant)", "");
  for (const p of participants) {
    lines.push(`- ${p.name} / ${p.role || "—"} : a encore des arguments = ${p.hasMoreArguments ? "oui" : "non"}`);
  }
  lines.push("", "## Messages récents", "");
  for (const ev of recent) {
    if (!VALID_KINDS.has(ev.kind)) continue;
    lines.push(`### ${ev.name || ev.speaker} / ${ev.role || "—"} / ${ev.kind}`, "", ev.body || "", "");
  }
  lines.push("## Instruction de facilitation", "");
  lines.push("Ne tranche pas tant qu'au moins un participant indique avoir encore des arguments.");
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
    topic:        state.topic,
    phase:        [...state.participants.values()].every(p => !p.hasMoreArguments) && state.participants.size > 0
                    ? "ready-to-arbitrate"
                    : "debating",
    participants: [...state.participants.values()],
    lastSeq:      state.lastSeq,
  };
  await writeAtomic(STATE_FILE, JSON.stringify(snapshot, null, 2));
}

async function handleIncoming(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { error: "invalid_json" }; }
  if (!msg.speaker || typeof msg.speaker !== "string") return { error: "missing_speaker" };
  if (!msg.kind || typeof msg.kind !== "string")       return { error: "missing_kind" };

  const knownKinds = new Set([...VALID_KINDS, "join", "presence", "status"]);
  if (!knownKinds.has(msg.kind)) return { error: "unknown_kind" };

  const ev = {
    seq:              state.lastSeq + 1,
    speaker:          msg.speaker.slice(0, 64),
    name:             (msg.name  ?? "").slice(0, 64),
    role:             (msg.role  ?? "").slice(0, 64),
    kind:             msg.kind,
    body:             (msg.body  ?? "").slice(0, 4000),
    hasMoreArguments: msg.hasMoreArguments !== undefined ? !!msg.hasMoreArguments : undefined,
    ts:               new Date().toISOString(),
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
  ws.send(JSON.stringify({ kind: "hello", state: snapshotForClient() }));

  ws.on("message", async (raw) => {
    const result = await handleIncoming(raw.toString());
    if (result.error) {
      ws.send(JSON.stringify({ kind: "error", message: result.error }));
      return;
    }
    broadcast({ kind: "event", ev: result.ev, snapshot: snapshotForClient() });
  });
});

function snapshotForClient() {
  return {
    session:      SESSION_NAME,
    topic:        state.topic,
    participants: [...state.participants.values()],
    lastSeq:      state.lastSeq,
  };
}

await ensureStateDir();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[team-claude-host] session=${SESSION_NAME} listening on :${PORT} ws=${WS_PATH}`);
});

const shutdown = (sig) => () => {
  console.log(`[team-claude-host] ${sig} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT",  shutdown("SIGINT"));
