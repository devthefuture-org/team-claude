// Tails the Claude Code session transcript (~/.claude/projects/<key>/<uuid>.jsonl)
// and emits a filtered, participant-safe event stream:
//   { kind: "claude-event", entry: { role, text?, tool?, ts } }
//   { kind: "claude-status", state: "thinking"|"idle", since? }
//
// Filters: keep user/assistant text + assistant tool_use summaries; skip
// tool_result and other internal types (can contain secrets / large output).
//
// Detects mid-conversation session rotation (e.g. `claude --continue` creates
// a new uuid.jsonl) by polling for a newer file every few seconds.

import { spawn } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const POLL_INTERVAL_MS = 3000;

function workspaceKey(workspaceDir) {
  return workspaceDir.replace(/\//g, "-");
}

function findLatestJsonl(projectDir) {
  if (!existsSync(projectDir)) return null;
  let latest = null;
  let latestMtime = 0;
  for (const entry of readdirSync(projectDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const p = join(projectDir, entry);
    try {
      const m = statSync(p).mtimeMs;
      if (m > latestMtime) { latest = p; latestMtime = m; }
    } catch {}
  }
  return latest;
}

function transformEntry(raw) {
  if (raw.type === "user" && raw.message?.role === "user") {
    const txt = extractText(raw.message.content);
    if (!txt) return null;
    // Claude's Monitor skill injects each participant drop into the
    // conversation as a synthetic user message wrapped in <task-notification>.
    // The participant event itself is already streamed via kind:"event", so
    // skip the duplicate to avoid two cards for the same drop.
    if (txt.includes("<task-notification>")) return null;
    return { role: "user", text: txt, ts: raw.timestamp };
  }
  if (raw.type === "assistant" && raw.message?.role === "assistant") {
    const parts = Array.isArray(raw.message.content) ? raw.message.content : [];
    const out = [];
    for (const p of parts) {
      if (p.type === "text" && p.text) {
        out.push({ role: "assistant", text: p.text, ts: raw.timestamp });
      } else if (p.type === "tool_use" && p.name) {
        const d = describeTool(p);
        out.push({
          role: "assistant", tool: p.name, id: p.id,
          summary: d.summary, params: d.params, diff: d.diff,
          ts: raw.timestamp,
        });
      }
    }
    return out.length ? out : null;
  }
  return null;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.filter(p => p.type === "text" && p.text).map(p => p.text).join("\n").trim() || null;
}

// Caps to keep the streamed payload bounded (and to avoid dumping huge files).
const MAX_PARAM_CHARS = 4000;
const MAX_DIFF_LINES  = 400;
const MAX_LINE_CHARS  = 300;

function clampStr(s, max = MAX_PARAM_CHARS) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
function oneLine(s, max) {
  const t = String(s).split("\n")[0].slice(0, max);
  return t.length < String(s).length ? t + "…" : t;
}
function param(label, value, { mono = false, block = false } = {}) {
  return { label, value: clampStr(value), mono, block };
}

// Build a rich, native-Claude-Code-like description of a tool call: a concise
// `summary` (target line, also used by the extension), a curated list of
// `params`, and a computed `diff` for file edits. We read straight from the
// tool_use input (old_string/new_string/content) so no tool_result — which can
// carry command output / secrets — is ever needed.
function describeTool(toolUse) {
  const name = toolUse.name;
  const i = toolUse.input ?? {};
  const params = [];
  let diff = null;
  let summary = "";

  switch (name) {
    case "Bash":
      summary = oneLine(i.command ?? "", 120);
      if (i.description) params.push(param("description", i.description));
      if (i.command)     params.push(param("$", i.command, { mono: true, block: true }));
      if (i.run_in_background) params.push(param("run_in_background", "true"));
      if (i.timeout)     params.push(param("timeout", `${i.timeout} ms`));
      break;

    case "Read":
      summary = i.file_path ?? "";
      if (i.file_path) params.push(param("file", i.file_path, { mono: true }));
      if (i.offset)    params.push(param("offset", String(i.offset)));
      if (i.limit)     params.push(param("limit", String(i.limit)));
      break;

    case "Edit":
      summary = i.file_path ? `→ ${i.file_path}` : "";
      if (i.file_path)    params.push(param("file", i.file_path, { mono: true }));
      if (i.replace_all)  params.push(param("replace_all", "true"));
      diff = lineDiff(i.old_string ?? "", i.new_string ?? "");
      break;

    case "MultiEdit":
      summary = i.file_path ? `→ ${i.file_path}` : "";
      if (i.file_path) params.push(param("file", i.file_path, { mono: true }));
      if (Array.isArray(i.edits)) {
        params.push(param("edits", `${i.edits.length} modification(s)`));
        diff = [];
        for (const e of i.edits) {
          if (diff.length) diff.push({ t: "sep", s: "" });
          for (const d of lineDiff(e.old_string ?? "", e.new_string ?? "")) diff.push(d);
          if (diff.length > MAX_DIFF_LINES) break;
        }
      }
      break;

    case "Write":
      summary = i.file_path ? `→ ${i.file_path}` : "";
      if (i.file_path) params.push(param("file", i.file_path, { mono: true }));
      // Whole new file → render every line as an addition.
      diff = String(i.content ?? "").split("\n")
        .slice(0, MAX_DIFF_LINES)
        .map(s => ({ t: "add", s: s.slice(0, MAX_LINE_CHARS) }));
      break;

    case "Glob":
      summary = i.pattern ?? "";
      if (i.pattern) params.push(param("pattern", i.pattern, { mono: true }));
      if (i.path)    params.push(param("path", i.path, { mono: true }));
      break;

    case "Grep":
      summary = oneLine(i.pattern ?? "", 80);
      if (i.pattern)      params.push(param("pattern", i.pattern, { mono: true }));
      if (i.path)         params.push(param("path", i.path, { mono: true }));
      if (i.glob)         params.push(param("glob", i.glob, { mono: true }));
      if (i.output_mode)  params.push(param("output_mode", i.output_mode));
      if (i["-n"])        params.push(param("-n", "true"));
      if (i["-i"])        params.push(param("-i", "true"));
      break;

    case "Task":
      summary = i.description ?? i.subagent_type ?? "";
      if (i.subagent_type) params.push(param("agent", i.subagent_type));
      if (i.description)   params.push(param("description", i.description));
      if (i.prompt)        params.push(param("prompt", i.prompt, { block: true }));
      break;

    case "WebFetch":
      summary = i.url ?? "";
      if (i.url)    params.push(param("url", i.url, { mono: true }));
      if (i.prompt) params.push(param("prompt", i.prompt, { block: true }));
      break;

    case "WebSearch":
      summary = i.query ?? "";
      if (i.query) params.push(param("query", i.query));
      break;

    case "TodoWrite":
      if (Array.isArray(i.todos)) {
        summary = `${i.todos.length} tâche(s)`;
        for (const t of i.todos) {
          const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○";
          params.push(param(mark, t.content ?? ""));
        }
      }
      break;

    default:
      // Unknown tool — surface every scalar input field, exhaustively.
      for (const [k, v] of Object.entries(i)) {
        if (v == null) continue;
        if (typeof v === "object") { params.push(param(k, Array.isArray(v) ? `[${v.length} éléments]` : "{…}")); continue; }
        params.push(param(k, String(v), { mono: true }));
      }
      summary = params[0]?.value ?? "";
  }

  return { summary, params, diff: diff && diff.length ? diff : null };
}

// Minimal LCS line diff → list of { t: "ctx"|"add"|"del", s } rows.
function lineDiff(oldStr, newStr) {
  const A = String(oldStr).split("\n").slice(0, MAX_DIFF_LINES);
  const B = String(newStr).split("\n").slice(0, MAX_DIFF_LINES);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let x = n - 1; x >= 0; x--)
    for (let y = m - 1; y >= 0; y--)
      dp[x][y] = A[x] === B[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  const out = [];
  let x = 0, y = 0;
  const push = (t, s) => out.push({ t, s: String(s).slice(0, MAX_LINE_CHARS) });
  while (x < n && y < m) {
    if (A[x] === B[y]) { push("ctx", A[x]); x++; y++; }
    else if (dp[x + 1][y] >= dp[x][y + 1]) { push("del", A[x]); x++; }
    else { push("add", B[y]); y++; }
  }
  while (x < n) push("del", A[x++]);
  while (y < m) push("add", B[y++]);
  return out;
}

export function startClaudeStream({ workspaceDir, claudeConfigDir, onEvent, onStatus, log }) {
  const projectKey = workspaceKey(workspaceDir);
  const projectDir = join(claudeConfigDir, "projects", projectKey);
  log?.(`watching Claude transcripts in ${projectDir}`);

  let currentFile = null;
  let child = null;
  let thinking = false;

  const setThinking = (on) => {
    if (on === thinking) return;
    thinking = on;
    onStatus({ state: on ? "thinking" : "idle", since: new Date().toISOString() });
  };

  const tailFile = (file) => {
    if (child) { try { child.kill("SIGTERM"); } catch {} child = null; }
    currentFile = file;
    log?.(`tailing ${file}`);
    // Start from the beginning so newcomers see the conversation so far.
    child = spawn("tail", ["-n", "+1", "-F", file], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { continue; }
        const transformed = transformEntry(raw);
        if (!transformed) continue;
        const items = Array.isArray(transformed) ? transformed : [transformed];
        for (const entry of items) onEvent(entry);
        // user → thinking on; assistant text → thinking off
        if (items.some(e => e.role === "user"))                            setThinking(true);
        if (items.some(e => e.role === "assistant" && e.text))             setThinking(false);
      }
    });
    child.stderr.on("data", (c) => log?.(`tail stderr: ${c.toString().trim()}`));
    child.on("exit", (code) => {
      log?.(`tail exited (${code}); will respawn on next poll`);
      child = null;
    });
  };

  const poll = () => {
    const latest = findLatestJsonl(projectDir);
    if (latest && latest !== currentFile) {
      tailFile(latest);
    } else if (latest && !child) {
      // Same file but the tail subprocess died — respawn. seenClaudeKeys in
      // the server dedups the re-emission of `tail -n +1`.
      tailFile(latest);
    }
  };

  poll();
  const timer = setInterval(poll, POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    if (child) { try { child.kill("SIGTERM"); } catch {} }
  };
}
