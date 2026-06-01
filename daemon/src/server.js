import { createServer } from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { startClaudeStream } from "./claude-stream.js";
import { findOAuthCallbackPort, proxyToLocalhost } from "./oauth-proxy.js";
import { writeAtomic, htmlEscape, readBody, sendJson, sendHtml, loadJsonMap } from "./util.js";

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
// in-progress conversation when they connect. Map keyed by content hash so
// the dedup check (against `tail -F` respawn / session rotation re-emits)
// and the FIFO order live in a single structure — no drift between two
// data structures kept in sync manually.
const claudeBuffer = new Map(); // claudeKey → entry, insertion-ordered
const CLAUDE_BUFFER_MAX = 200;
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

// We never store raw participant bearer tokens on disk — a shell inside the
// pod (mob coder, leaked code-server password, host CLI snoop) could read
// participants.json otherwise and impersonate every participant. Instead we
// store HMAC-SHA256(token, ROOM_TOKEN) and authenticate by hashing the
// submitted token and looking it up. The raw token only lives in the
// participant's browser URL.
function hashToken(token) {
  if (!ROOM_TOKEN) throw new Error("ROOM_TOKEN not configured — cannot hash");
  return createHmac("sha256", ROOM_TOKEN).update(String(token)).digest("hex");
}
// Constant-time check on the Map.get result so a comparison side-channel
// doesn't help an attacker enumerate valid hashes.
function findParticipantByRawToken(rawToken) {
  if (!rawToken || !ROOM_TOKEN) return null;
  const h = hashToken(rawToken);
  const p = participants.get(h);
  if (!p) return null;
  // Cheap defense-in-depth: confirm the key matches via timingSafeEqual.
  const a = Buffer.from(h, "hex"), b = Buffer.from(p.tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return p.revokedAt ? null : p;
}

// Strip tokenHash before returning a participant over HTTP / WS.
function safeParticipantView(p) {
  return {
    speaker:         p.speaker,
    pseudo:          p.pseudo,
    joinedAt:        p.joinedAt,
    lastSeenAt:      p.lastSeenAt,
    revokedAt:       p.revokedAt,
    fromInvite:      p.fromInvite,
    firstIp:         p.firstIp ?? null,
    lastIp:          p.lastIp ?? null,
    connectionCount: p.connectionCount ?? 0,
  };
}

async function loadInvites() { return loadJsonMap(INVITES_FILE, "invites", "code", invites); }

async function loadParticipants() {
  // We changed the on-disk schema from `.token` (raw) to `.tokenHash`.
  // Hand-roll the load so legacy files can be migrated in place rather
  // than dropped (and we still go through the same ENOENT-tolerant path).
  let raw;
  try { raw = await readFile(PARTICIPANTS_FILE, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return; throw e; }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { console.error(`[team-claude-host] bad ${PARTICIPANTS_FILE}:`, e.message); return; }
  let migrated = 0;
  for (const r of data.participants ?? []) {
    if (!r.tokenHash && r.token) {
      r.tokenHash = hashToken(r.token);
      delete r.token;
      migrated++;
    }
    if (!r.tokenHash) continue;
    participants.set(r.tokenHash, r);
  }
  if (migrated > 0) {
    console.log(`[team-claude-host] migrated ${migrated} participant token(s) to HMAC hashes`);
    await persistParticipants();
  }
}

async function persistInvites() {
  await writeAtomic(INVITES_FILE, JSON.stringify({ invites: [...invites.values()] }, null, 2));
}

async function persistParticipants() {
  // Persist the full record (token included). The file is only readable
  // inside the pod (PVC, restricted security context).
  await writeAtomic(PARTICIPANTS_FILE, JSON.stringify({ participants: [...participants.values()] }, null, 2));
}

// lastSeenAt updates fire on every WS message. Coalesce them so we rewrite
// participants.json at most once every ~2s instead of once per message.
// Crash-loss of a few seconds of lastSeenAt is acceptable; immediate writes
// (invite consume, revoke) still bypass this and call persistParticipants
// directly.
let lastSeenFlushTimer = null;
const LAST_SEEN_FLUSH_MS = 2000;
function scheduleLastSeenFlush() {
  if (lastSeenFlushTimer) return;
  lastSeenFlushTimer = setTimeout(() => {
    lastSeenFlushTimer = null;
    persistParticipants().catch(e =>
      console.error("[team-claude-host] persistParticipants (lastSeen flush):", e.message));
  }, LAST_SEEN_FLUSH_MS);
}

// Normalize and sanitize a participant pseudo so visually-identical strings
// (NFC vs NFD, trailing whitespace, embedded zero-widths, control chars,
// homoglyph-friendly junk) collapse to the same key — protects revoke and
// uniqueness checks from impersonation via lookalike pseudos.
const PSEUDO_DISALLOWED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
function normalizePseudo(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(PSEUDO_DISALLOWED, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function findParticipantByPseudo(pseudo) {
  const norm = normalizePseudo(pseudo);
  if (!norm) return null;
  for (const p of participants.values()) {
    if (p.pseudo === norm && !p.revokedAt) return p;
  }
  return null;
}

function authenticate(token) {
  if (!token) return null;
  if (ROOM_TOKEN && token === ROOM_TOKEN) return { kind: "host" };
  const p = findParticipantByRawToken(token);
  if (p) return { kind: "participant", record: p };
  return null;
}

// Consume an invite code race-safely (re-check inside the serialize() queue
// so two concurrent submits can't both succeed). Returns one of:
//   { record }                  on success
//   { error: "consumed" }       if the code was already used
//   { error: "pseudo_taken" }   if the pseudo was claimed between the
//                               form load and submit
async function consumeInvite(code, pseudo, firstIp) {
  return serialize(async () => {
    const inv = invites.get(code);
    if (!inv || inv.consumedAt) return { error: "consumed" };
    if (findParticipantByPseudo(pseudo)) return { error: "pseudo_taken" };
    const now = new Date().toISOString();
    const rawToken = randomToken();
    const record = {
      tokenHash:       hashToken(rawToken),
      speaker:         randomUUID(),
      pseudo,
      joinedAt:        now,
      lastSeenAt:      now,
      revokedAt:       null,
      fromInvite:      code,
      // Audit fields for the admin UI. firstIp is locked at consume;
      // lastIp + connectionCount track WS reconnect activity.
      firstIp:         firstIp || null,
      lastIp:          firstIp || null,
      connectionCount: 0,
    };
    inv.consumedAt = now;
    inv.consumedBy = pseudo;
    participants.set(record.tokenHash, record);
    await Promise.all([persistInvites(), persistParticipants()]);
    return { record, rawToken };
  });
}

async function ensureStateDir() {
  await mkdir(STATE_DIR, { recursive: true });
  await Promise.all([
    replayEvents(),
    loadInvites(),
    loadParticipants(),
  ]);
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
  trimParticipantBuffer();
  console.log(`[team-claude-host] replayed up to seq=${state.lastSeq}, participants=${state.participants.size}`);
}

function applyEvent(ev) {
  state.lastSeq = Math.max(state.lastSeq, ev.seq ?? 0);
  if (ev.ts) state.lastMessageAt = ev.ts;
  if (ev.body) participantBuffer.push(ev);
  if (!ev.speaker) return;
  state.participants.set(ev.speaker, {
    id:         ev.speaker,
    name:       ev.name || ev.speaker,
    lastSeenAt: ev.ts || state.lastMessageAt,
  });
}

function trimParticipantBuffer() {
  if (participantBuffer.length > PARTICIPANT_BUFFER_MAX) {
    participantBuffer.splice(0, participantBuffer.length - PARTICIPANT_BUFFER_MAX);
  }
}

async function persistEvent(ev) {
  await appendFile(EVENTS_FILE, JSON.stringify(ev) + "\n");
}

function formatTime(ts) {
  try { return new Date(ts).toISOString().slice(11, 19) + "Z"; }
  catch { return ts ?? ""; }
}

// Render a participant body inside a fenced code block, picking a fence
// longer than the longest backtick run in the body so an attacker can't
// inject markdown that breaks out of the quoted message.
function fenceBody(body) {
  let longest = 0;
  const re = /`{3,}/g;
  let m;
  while ((m = re.exec(body)) !== null) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

async function regenerateLive() {
  const lines = [];
  lines.push("# Session collaborative", "");
  lines.push(`_Session : ${SESSION_NAME} — ${state.participants.size} participant(s), ${state.lastSeq} message(s)_`, "");
  if (!participantBuffer.length) {
    lines.push("(aucun message pour l'instant)", "");
  } else {
    for (const ev of participantBuffer) {
      if (!ev.body) continue;
      // Strip backticks from the heading line so a crafted name can't open
      // its own fence; the body is fence-protected above.
      const safeName = String(ev.name || ev.speaker).replace(/`/g, "'");
      lines.push(`### ${safeName} — ${formatTime(ev.ts)}`, "", fenceBody(ev.body), "");
    }
  }
  await writeAtomic(LIVE_FILE, lines.join("\n"));
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
    scheduleLastSeenFlush();
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
  trimParticipantBuffer();
  await persistEvent(ev);
  // live.md and state.json are independent atomic writes — issue them in
  // parallel inside the serialized handler so we double-buffer fsyncs.
  await Promise.all([regenerateLive(), regenerateState()]);
  return { ok: true, ev };
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function renderShell({ title, header, body, centered = false }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<script>try{var t=localStorage.getItem("team-claude.theme");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}</script>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1>team-claude</h1><span class="muted">${header}</span><span class="spacer"></span></header>
<main${centered ? ` class="centered"` : ""}>${body}</main>
<script type="module">import { mountThemeToggle } from "/ui.js"; mountThemeToggle();</script>
</body>
</html>`;
}

function renderInvitePage({ code, sessionName, intendedFor, error, pseudo }) {
  const greeting = intendedFor
    ? `<p>Hey <strong>${htmlEscape(intendedFor)}</strong> 👋 — on t'a réservé une place. Le pseudo est pré-rempli, libre à toi de le changer.</p>`
    : `<p>Tu es invité·e à suivre cette session en direct et à y déposer des messages.</p>`;
  return renderShell({
    title:  `team-claude — invitation ${sessionName}`,
    header: `invitation · session ${htmlEscape(sessionName)}`,
    centered: true,
    body: `<section class="card-narrow">
    <h2>Choisis ton pseudo</h2>
    ${greeting}
    <p class="muted">Une fois rejoint·e, ton pseudo est fixe pour cette session.</p>
    ${error ? `<p class="form-error" id="invite-error" role="alert">${htmlEscape(error)}</p>` : ""}
    <form method="POST" action="/invite/${htmlEscape(code)}" autocomplete="off">
      <div class="row">
        <label for="pseudo">Pseudo
          <input id="pseudo" name="pseudo" required minlength="1" maxlength="32" autofocus
                 value="${htmlEscape(pseudo ?? "")}" placeholder="Alice"
                 ${error ? `aria-describedby="invite-error" aria-invalid="true"` : ""}>
        </label>
      </div>
      <button type="submit">Rejoindre la session</button>
    </form>
  </section>`,
  });
}

function renderErrorPage({ sessionName, title, message }) {
  return renderShell({
    title:  `team-claude — ${title}`,
    header: `session ${htmlEscape(sessionName)}`,
    centered: true,
    body: `<section class="card-narrow" role="alert">
  <div class="state-icon err" aria-hidden="true">⚠</div>
  <h2 style="color:var(--err)">${htmlEscape(title)}</h2>
  <p>${htmlEscape(message)}</p>
  <p class="muted">Demande un nouveau lien d'invitation au host de la session.</p>
</section>`,
  });
}

function requireAdmin(req, res) {
  const url = new URL(req.url, "http://x");
  const tok = url.searchParams.get("token");
  if (!ROOM_TOKEN || tok !== ROOM_TOKEN) {
    sendJson(res, 401, { error: "unauthorized" });
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

// Defense-in-depth headers applied to every response. The room token rides
// in the URL query — `Referrer-Policy: no-referrer` keeps it out of
// outbound Referer headers should the page ever load an external resource.
// Other headers are cheap belt-and-braces.
function setSecurityHeaders(res) {
  res.setHeader("Referrer-Policy",        "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options",        "SAMEORIGIN");
}

// ─── Per-IP rate limits ──────────────────────────────────────────────────
// Sliding-window counters protect the cheap-but-amplifying endpoints:
// invite minting + consumption, revoke, and WS upgrade. The Map is bounded
// by a periodic sweep so an attacker can't grow it unboundedly by varying
// the source IP.
const rateLimitState = new Map(); // "scope|ip" → { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60_000;
function clientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
function rateLimit(scope, ip, max) {
  const key = `${scope}|${ip}`;
  const now = Date.now();
  const entry = rateLimitState.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [k, v] of rateLimitState) {
    if (v.windowStart < cutoff) rateLimitState.delete(k);
  }
}, 5 * 60_000).unref();

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  if (req.url.startsWith(HEALTH_PATH)) {
    sendJson(res, 200, { status: "ok", session: SESSION_NAME, lastSeq: state.lastSeq });
    return;
  }
  if (req.url === "/session.json") {
    sendJson(res, 200, { session: SESSION_NAME, wsPath: WS_PATH });
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
      // Enforce the same reserved-port allowlist as the auto-discover path
      // so `?_port=` can't be used to reach code-server (8080), sshd (22 /
      // 2222) or the daemon itself (PORT). Without this, /callback is an
      // unauthenticated SSRF/port-scanner of the pod's loopback.
      if (RESERVED_LOCAL_PORTS.has(port) || port < 1024 || port > 65535) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`oauth-proxy: port ${port} is reserved or out of the ephemeral range.\n`);
        return;
      }
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
    // Rate-limit the whole route before any code lookup so an attacker
    // can't burn through codes via 404/410 timing channels.
    if (!rateLimit("invite_route", clientIp(req), req.method === "POST" ? 10 : 30)) {
      sendHtml(res, 429, renderErrorPage({ sessionName: SESSION_NAME, title: "Trop d'essais", message: "Trop de tentatives. Réessaye dans une minute." }));
      return;
    }
    const invite = invites.get(code);
    if (!invite) {
      sendHtml(res, 404, renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation inconnue", message: "Ce code d'invitation n'existe pas (ou plus). Demande au host de t'en envoyer un nouveau." }));
      return;
    }
    if (invite.consumedAt) {
      sendHtml(res, 410, renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation déjà utilisée", message: `Ce code a déjà été consommé par ${invite.consumedBy} le ${invite.consumedAt}. Demande au host un nouveau code.` }));
      return;
    }
    if (req.method === "GET") {
      // Pre-fill the pseudo input with the admin's suggested name when set —
      // still editable in case the participant prefers a different handle.
      sendHtml(res, 200, renderInvitePage({ code, sessionName: SESSION_NAME, intendedFor: invite.intendedFor, pseudo: invite.intendedFor }));
      return;
    }
    if (req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch { res.writeHead(413).end("body too large"); return; }
      const pseudo = normalizePseudo(new URLSearchParams(body).get("pseudo"));
      if (!pseudo) {
        sendHtml(res, 400, renderInvitePage({ code, sessionName: SESSION_NAME, intendedFor: invite.intendedFor, error: "Pseudo requis.", pseudo }));
        return;
      }
      const result = await consumeInvite(code, pseudo, clientIp(req));
      if (result.error === "consumed") {
        sendHtml(res, 410, renderErrorPage({ sessionName: SESSION_NAME, title: "Invitation déjà utilisée", message: "Ce code vient d'être consommé." }));
        return;
      }
      if (result.error === "pseudo_taken") {
        sendHtml(res, 409, renderInvitePage({ code, sessionName: SESSION_NAME, intendedFor: invite.intendedFor, error: `Le pseudo « ${pseudo} » est déjà pris. Choisis-en un autre.`, pseudo }));
        return;
      }
      const location = `/?token=${encodeURIComponent(result.rawToken)}`;
      // 302 redirects instantly; the body is only seen if the client doesn't
      // auto-follow — give it a styled fallback with a manual link.
      const fallback = renderShell({
        title: "team-claude — connexion…",
        header: `session ${htmlEscape(SESSION_NAME)}`,
        centered: true,
        body: `<section class="card-narrow" style="text-align:center">
  <div class="spinner" style="margin:0 auto 0.75rem"></div>
  <p>Connexion à la session…</p>
  <p class="muted"><a href="${htmlEscape(location)}">Continuer manuellement</a> si rien ne se passe.</p>
</section>`,
      });
      res.writeHead(302, { "Location": location, "Content-Type": "text/html; charset=utf-8" });
      res.end(fallback);
      return;
    }
    res.writeHead(405).end("method not allowed");
    return;
  }

  // ── Admin UI (single-page app served at /admin, gated by the room token
  //    inside the page's JS). The token-in-URL pattern matches /room and
  //    /invite — same security model.
  {
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname === "/admin") {
      try {
        const data = await readFile(join(PUBLIC_DIR, "admin.html"));
        sendHtml(res, 200, data);
      } catch {
        res.writeHead(404).end("admin.html missing");
      }
      return;
    }
  }

  // ── Admin endpoints (gated by ROOM_TOKEN query param) ────────────────
  if (req.url.startsWith("/admin/")) {
    if (!requireAdmin(req, res)) return;
    const url = new URL(req.url, "http://x");
    // Throttle the mutating endpoints. The host's web admin auto-polls
    // GETs every 5s — those are bounded by the cache-poll cadence and
    // don't need a counter.
    const isMutation = req.method === "POST";
    if (isMutation && !rateLimit("admin_post", clientIp(req), 30)) {
      sendJson(res, 429, { error: "rate_limited" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/invite") {
      // Optional `intendedFor` (form-encoded body) lets the host label the
      // code with the name they're sending it to — visible in /admin and
      // pre-fills the participant's pseudo input.
      let intendedFor = null;
      try {
        const body = await readBody(req);
        if (body) intendedFor = normalizePseudo(new URLSearchParams(body).get("intendedFor")) || null;
      } catch { res.writeHead(413).end("body too large"); return; }
      const inv = {
        code:        randomCode(),
        createdAt:   new Date().toISOString(),
        intendedFor,
        consumedAt:  null,
        consumedBy:  null,
      };
      invites.set(inv.code, inv);
      await persistInvites();
      sendJson(res, 200, { code: inv.code, createdAt: inv.createdAt, intendedFor });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/invites") {
      sendJson(res, 200, { invites: [...invites.values()] });
      return;
    }
    // POST /admin/invite/<code> body: action=edit|regenerate|delete
    // Consumed invites stay as an audit trail — edit/regen/delete refuse.
    if (req.method === "POST" && url.pathname.startsWith("/admin/invite/")) {
      const code = url.pathname.slice("/admin/invite/".length);
      if (!code || code.includes("/")) { sendJson(res, 400, { error: "bad_code" }); return; }
      const invite = invites.get(code);
      if (!invite) { sendJson(res, 404, { error: "unknown_code" }); return; }
      let body;
      try { body = await readBody(req); } catch { res.writeHead(413).end("body too large"); return; }
      const params = new URLSearchParams(body);
      const action = params.get("action");
      if (invite.consumedAt && action !== "view") {
        sendJson(res, 409, { error: "already_consumed", action });
        return;
      }
      if (action === "edit") {
        invite.intendedFor = normalizePseudo(params.get("intendedFor")) || null;
        await persistInvites();
        sendJson(res, 200, { ok: true, code, intendedFor: invite.intendedFor });
        return;
      }
      if (action === "delete") {
        invites.delete(code);
        await persistInvites();
        sendJson(res, 200, { ok: true, code });
        return;
      }
      if (action === "regenerate") {
        const intendedFor = invite.intendedFor;
        invites.delete(code);
        const newInv = {
          code:        randomCode(),
          createdAt:   new Date().toISOString(),
          intendedFor,
          consumedAt:  null,
          consumedBy:  null,
        };
        invites.set(newInv.code, newInv);
        await persistInvites();
        sendJson(res, 200, { ok: true, code: newInv.code, oldCode: code, intendedFor });
        return;
      }
      sendJson(res, 400, { error: "unknown_action", action });
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/participants") {
      sendJson(res, 200, { participants: [...participants.values()].map(safeParticipantView) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/revoke") {
      let body;
      try { body = await readBody(req); } catch { res.writeHead(413).end("body too large"); return; }
      const pseudo = normalizePseudo(new URLSearchParams(body).get("pseudo"));
      const target = findParticipantByPseudo(pseudo);
      if (!target) {
        sendJson(res, 404, { error: "no_active_participant_with_that_pseudo", pseudo });
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
      sendJson(res, 200, { ok: true, pseudo, revokedAt: target.revokedAt });
      return;
    }
    res.writeHead(404).end("not found");
    return;
  }

  await safeServeStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

// WS Origin allowlist: when set, reject upgrades whose `Origin` header is
// neither empty (non-browser clients like our verify scripts have no Origin)
// nor in this list. Same-Origin Policy doesn't cover WebSocket — any page in
// the user's browser could otherwise piggy-back on a leaked token. Configure
// via WS_ALLOWED_ORIGINS=comma,separated list. Default = empty (off) keeps
// our CLI/test tooling working out of the box; the chart sets it explicitly.
const WS_ALLOWED_ORIGINS = new Set(
  (process.env.WS_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)
);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== WS_PATH) { socket.destroy(); return; }
  if (!rateLimit("ws_upgrade", clientIp(req), 30)) {
    socket.destroy(); return;
  }
  if (WS_ALLOWED_ORIGINS.size > 0) {
    const origin = req.headers.origin;
    if (origin && !WS_ALLOWED_ORIGINS.has(origin)) {
      console.warn(`[team-claude-host] WS upgrade rejected: origin=${origin}`);
      socket.destroy(); return;
    }
  }
  const auth = authenticate(url.searchParams.get("token"));
  if (!auth) { socket.destroy(); return; }
  if (auth.kind === "participant") {
    auth.record.connectionCount = (auth.record.connectionCount ?? 0) + 1;
    auth.record.lastIp = clientIp(req);
    scheduleLastSeenFlush();
  }
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
    claudeBacklog:      [...claudeBuffer.values()],
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
  if (claudeBuffer.has(k)) return;
  claudeBuffer.set(k, entry);
  if (claudeBuffer.size > CLAUDE_BUFFER_MAX) {
    claudeBuffer.delete(claudeBuffer.keys().next().value);
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
