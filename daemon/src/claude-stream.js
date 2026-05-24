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
        out.push({ role: "assistant", tool: p.name, summary: summarizeTool(p), ts: raw.timestamp });
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

function summarizeTool(toolUse) {
  const input = toolUse.input ?? {};
  // Show what the tool is acting on, never the bulk content (could leak secrets).
  if (toolUse.name === "Bash"   && input.command)     return oneLine(input.command, 120);
  if (toolUse.name === "Read"   && input.file_path)   return input.file_path;
  if (toolUse.name === "Write"  && input.file_path)   return `→ ${input.file_path}`;
  if (toolUse.name === "Edit"   && input.file_path)   return `→ ${input.file_path}`;
  if (toolUse.name === "Glob"   && input.pattern)     return input.pattern;
  if (toolUse.name === "Grep"   && input.pattern)     return oneLine(input.pattern, 80);
  if (toolUse.name === "WebFetch" && input.url)       return input.url;
  if (toolUse.name === "WebSearch" && input.query)    return input.query;
  return "";
}

function oneLine(s, max) {
  const t = String(s).split("\n")[0].slice(0, max);
  return t.length < String(s).length ? t + "…" : t;
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
