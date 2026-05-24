import { readFile, writeFile, rename } from "node:fs/promises";

export async function writeAtomic(path, content) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function readBody(req, maxBytes = 4096) {
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

export function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

export function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// Tolerant boot loader for `{ <key>: [ ...records ] }` JSON files: returns
// silently on ENOENT (first boot), logs and continues on parse errors.
export async function loadJsonMap(file, key, idField, map) {
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return; throw e; }
  try {
    const data = JSON.parse(raw);
    for (const r of data[key] ?? []) map.set(r[idField], r);
  } catch (e) {
    console.error(`[team-claude-host] bad ${file}:`, e.message);
  }
}
