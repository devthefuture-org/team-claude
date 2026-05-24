// Proxy for the OAuth callback that `claude` (and similar CLIs) starts on a
// random localhost port. On a remote pod the user's browser can't reach
// http://localhost:<port>/callback, so they hand-edit the URL host to the
// public team-claude daemon and the daemon relays the request to whatever
// ephemeral server is currently listening on localhost.
//
// All containers in a Kubernetes Pod share the network namespace, so the
// daemon can connect to localhost ports opened by any other container
// (the devcontainer where `claude` runs, in our case).
//
// Port discovery: parse /proc/net/tcp for LISTEN sockets on 127.0.0.1 or
// 0.0.0.0, filter out the daemon's own known ports, and probe each remaining
// candidate to find one that answers a GET to the requested path.

import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

const STATE_LISTEN = "0A";
const PROC_TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"];

function hexIpToString(hex) {
  // /proc/net/tcp encodes the IP in little-endian hex (per word). For our
  // purposes we only care about 127.0.0.1 (0100007F) and 0.0.0.0 (00000000)
  // in tcp, and ::1 (00…01) and :: (00…) in tcp6.
  if (hex.length === 8)  return /^0+$/.test(hex) ? "0.0.0.0" : (hex === "0100007F" ? "127.0.0.1" : `?:${hex}`);
  if (hex.length === 32) return /^0+1$/.test(hex.toUpperCase()) ? "::1" : (/^0+$/.test(hex) ? "::" : `?:${hex}`);
  return `?:${hex}`;
}

async function listLocalListenPorts() {
  const ports = new Set();
  for (const f of PROC_TCP_FILES) {
    let text;
    try { text = await readFile(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4 || parts[3] !== STATE_LISTEN) continue;
      const [hexIp, hexPort] = parts[1].split(":");
      const ip = hexIpToString(hexIp);
      if (ip !== "127.0.0.1" && ip !== "0.0.0.0" && ip !== "::1" && ip !== "::") continue;
      ports.add(parseInt(hexPort, 16));
    }
  }
  return [...ports];
}

function probePort(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "HEAD" }, (res) => {
      // Any HTTP response (even 4xx) proves it's a live HTTP server.
      res.resume();
      resolve({ port, status: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export async function findOAuthCallbackPort({ reservedPorts, probePath = "/callback", probeTimeoutMs = 250 }) {
  const all = await listLocalListenPorts();
  // Linux ephemeral range is typically 32768-60999; that's where short-lived
  // CLI OAuth servers grab a port. Reserved/well-known ports below 1024 and
  // our own services are excluded.
  const candidates = all
    .filter(p => p >= 32768 && p <= 60999 && !reservedPorts.has(p))
    .sort((a, b) => b - a); // most-recently-opened ports tend to be higher
  if (candidates.length === 0) return null;
  const results = await Promise.all(candidates.map(p => probePort(p, probePath, probeTimeoutMs)));
  const live = results.filter(Boolean);
  return live.length ? live[0].port : null;
}

export function proxyToLocalhost(port, req, res) {
  // Rewrite Host to localhost:<port> so the CLI's local OAuth server sees the
  // request as if the user's browser had reached it directly. Drop hop-by-hop
  // headers and proxy chain noise that an ephemeral CLI server won't expect.
  const headers = { ...req.headers, host: `localhost:${port}` };
  for (const h of ["connection", "x-forwarded-for", "x-forwarded-proto",
                   "x-forwarded-host", "x-real-ip"]) delete headers[h];
  const upstream = httpRequest(
    { hostname: "127.0.0.1", port, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`oauth-proxy: upstream connection failed: ${e.message}\n`);
  });
  req.pipe(upstream);
}
