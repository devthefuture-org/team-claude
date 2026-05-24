export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Compact HH:MM for the stream pane.
export function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

// Full date + time for the admin tables.
export function formatDateTime(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); }
  catch { return ts; }
}
