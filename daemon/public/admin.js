import { escapeHtml, formatDateTime as fmtTime } from "/util.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");
const els = {
  status:               $("status"),
  sessionName:          $("session-name"),
  streamLink:           $("participant-stream-link"),
  invitesBody:          $("invites-body"),
  participantsBody:     $("participants-body"),
  mintBtn:              $("mint-btn"),
  reloadBtn:            $("reload-btn"),
  intendedFor:          $("intended-for"),
};

const POLL_MS = 5000;

if (!TOKEN) {
  els.sessionName.textContent = "manque ?token=… dans l'URL";
  throw new Error("no token");
}

// "→ stream live" link reuses the same room token (host is allowed in the WS).
els.streamLink.href = `/?token=${encodeURIComponent(TOKEN)}`;

function setOnline(ok) {
  els.status.textContent = ok ? "online" : "offline";
  els.status.classList.toggle("status-online", ok);
  els.status.classList.toggle("status-offline", !ok);
}

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(method, path, body) {
  const url = `${path}?token=${encodeURIComponent(TOKEN)}`;
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    opts.body    = new URLSearchParams(body).toString();
  }
  const r = await fetch(url, opts);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} → ${r.status} ${txt}`);
  }
  return r.json();
}

function inviteUrl(code) {
  return `${location.origin}/invite/${code}`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("URL copiée"); }
  catch { toast("Impossible de copier (HTTPS requis)", "err"); }
}

// participants keyed by their fromInvite code → cross-ref for both tables.
let inviteByConsumer = new Map();   // pseudo → invite
function rebuildIndex(invites) {
  inviteByConsumer = new Map();
  for (const inv of invites) {
    if (inv.consumedBy) inviteByConsumer.set(inv.consumedBy, inv);
  }
}

function renderInvites(invites) {
  if (!invites.length) {
    els.invitesBody.innerHTML = `<tr><td colspan="5" class="muted">(aucun code généré)</td></tr>`;
    return;
  }
  invites.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  els.invitesBody.innerHTML = invites.map(inv => {
    const consumed = !!inv.consumedAt;
    const url = inviteUrl(inv.code);
    const intendedCell = inv.intendedFor
      ? `<strong>${escapeHtml(inv.intendedFor)}</strong>`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td><code>${escapeHtml(inv.code)}</code></td>
      <td>${intendedCell}</td>
      <td>${fmtTime(inv.createdAt)}</td>
      <td class="url-cell">${consumed
        ? `<span class="muted">consommé par <strong>${escapeHtml(inv.consumedBy)}</strong> le ${fmtTime(inv.consumedAt)}</span>`
        : `<a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a>
           <button class="secondary" data-copy="${escapeHtml(url)}" type="button" style="margin-left:0.5rem">copier</button>`}
      </td>
      <td><span class="pill ${consumed ? "consumed" : "pending"}">${consumed ? "consommé" : "en attente"}</span></td>
    </tr>`;
  }).join("");
  els.invitesBody.querySelectorAll("button[data-copy]").forEach(btn => {
    btn.addEventListener("click", () => copy(btn.dataset.copy));
  });
}

function renderParticipants(participants) {
  if (!participants.length) {
    els.participantsBody.innerHTML = `<tr><td colspan="8" class="muted">(aucun participant n'a encore rejoint)</td></tr>`;
    return;
  }
  participants.sort((a, b) => Date.parse(b.joinedAt) - Date.parse(a.joinedAt));
  els.participantsBody.innerHTML = participants.map(p => {
    const revoked = !!p.revokedAt;
    const sourceInvite = inviteByConsumer.get(p.pseudo);
    const invitedAs = sourceInvite?.intendedFor
      ? escapeHtml(sourceInvite.intendedFor) + (sourceInvite.intendedFor === p.pseudo ? "" : ` <span class="muted">(renommé)</span>`)
      : `<span class="muted">—</span>`;
    const ipCell = p.firstIp
      ? (p.lastIp && p.lastIp !== p.firstIp
          ? `<span title="première connexion: ${escapeHtml(p.firstIp)}">${escapeHtml(p.lastIp)}</span>`
          : `${escapeHtml(p.firstIp)}`)
      : `<span class="muted">—</span>`;
    return `<tr>
      <td><strong>${escapeHtml(p.pseudo)}</strong></td>
      <td>${invitedAs}</td>
      <td>${fmtTime(p.joinedAt)}</td>
      <td>${fmtTime(p.lastSeenAt)}</td>
      <td>${p.connectionCount ?? 0}</td>
      <td class="url-cell">${ipCell}</td>
      <td>${revoked
        ? `<span class="pill revoked" title="révoqué le ${escapeHtml(p.revokedAt)}">révoqué</span>`
        : `<span class="pill active">actif</span>`}</td>
      <td>${revoked
        ? `<span class="muted">—</span>`
        : `<button class="danger" data-revoke="${escapeHtml(p.pseudo)}" type="button">Révoquer</button>`}</td>
    </tr>`;
  }).join("");
  els.participantsBody.querySelectorAll("button[data-revoke]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const pseudo = btn.dataset.revoke;
      if (!confirm(`Révoquer le token de ${pseudo} ? Sa WS sera fermée immédiatement et il devra utiliser une nouvelle invitation pour revenir.`)) return;
      btn.disabled = true;
      try {
        await api("POST", "/admin/revoke", { pseudo });
        toast(`${pseudo} révoqué`);
        await refresh();
      } catch (e) {
        toast(`Erreur: ${e.message}`, "err");
        btn.disabled = false;
      }
    });
  });
}

async function refresh() {
  try {
    const [invitesResp, participantsResp, sessionResp] = await Promise.all([
      api("GET", "/admin/invites"),
      api("GET", "/admin/participants"),
      fetch("/session.json").then(r => r.json()).catch(() => null),
    ]);
    setOnline(true);
    if (sessionResp?.session) els.sessionName.textContent = `session: ${sessionResp.session}`;
    rebuildIndex(invitesResp.invites ?? []);
    renderInvites(invitesResp.invites ?? []);
    renderParticipants(participantsResp.participants ?? []);
  } catch (e) {
    setOnline(false);
    if (String(e.message).includes("401")) {
      els.sessionName.textContent = "token invalide (401)";
    }
  }
}

async function mintInvite() {
  els.mintBtn.disabled = true;
  try {
    const intendedFor = els.intendedFor.value.trim();
    const { code } = await api("POST", "/admin/invite", intendedFor ? { intendedFor } : null);
    await copy(inviteUrl(code));
    toast(intendedFor ? `Invitation pour ${intendedFor} générée + URL copiée` : "Nouvelle invitation générée + URL copiée");
    els.intendedFor.value = "";
    await refresh();
  } catch (e) {
    toast(`Erreur: ${e.message}`, "err");
  } finally {
    els.mintBtn.disabled = false;
  }
}

els.mintBtn.addEventListener("click", mintInvite);
els.intendedFor.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); mintInvite(); }
});

els.reloadBtn.addEventListener("click", refresh);

refresh();
setInterval(refresh, POLL_MS);
