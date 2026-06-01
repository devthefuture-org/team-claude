// Shared, dependency-free UI primitives for the team-claude web surfaces.
// Imported by app.js (stream) and admin.js (dashboard). Server-rendered pages
// (invite/error) load it too for the theme toggle.
//
// Anti-FOUC note: the actual theme is applied by a tiny inline <head> script
// before paint (see THEME_BOOTSTRAP). This module only reads/writes the stored
// preference and renders the toggle + dialogs.

const THEME_KEY = "team-claude.theme";

/* Inline this string in a <head> <script> on every page so the theme is set
   before the stylesheet paints (no flash). Kept here as the single source of
   truth; server.js embeds the same logic in renderShell(). */
export const THEME_BOOTSTRAP =
  `try{var t=localStorage.getItem("${THEME_KEY}");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}`;

export function getTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  document.querySelectorAll(".theme-toggle").forEach(updateToggleIcon);
}

export function toggleTheme() {
  setTheme(getTheme() === "light" ? "dark" : "light");
}

function updateToggleIcon(btn) {
  const dark = getTheme() === "dark";
  btn.textContent = dark ? "☾" : "☀";
  btn.setAttribute("aria-label", dark ? "Passer en thème clair" : "Passer en thème sombre");
  btn.title = btn.getAttribute("aria-label");
}

/** Inject a ☀/☾ toggle button into `container` (defaults to the header). */
export function mountThemeToggle(container = document.querySelector("header")) {
  if (!container) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-toggle";
  updateToggleIcon(btn);
  btn.addEventListener("click", toggleTheme);
  container.appendChild(btn);
  return btn;
}

/* ------------------------------------------------------------------ Toasts */

function toastStack() {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}

/** Show a stacking toast. kind: "ok" | "err". Returns the element. */
export function toast(msg, kind = "ok", { duration = 3200 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = kind === "err" ? "⚠" : "✓";

  const text = document.createElement("span");
  text.className = "toast-msg";
  text.textContent = msg;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Fermer");
  close.textContent = "×";

  el.append(icon, text, close);
  toastStack().appendChild(el);

  let timer;
  const dismiss = () => {
    if (el.classList.contains("leaving")) return;
    clearTimeout(timer);
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  if (duration) timer = setTimeout(dismiss, duration);
  return el;
}

/** Copy text to the clipboard, with user feedback via toast. */
export async function copyToClipboard(text, okMsg = "Copié dans le presse-papiers") {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
    return true;
  } catch {
    toast("Copie impossible (HTTPS requis pour le presse-papiers)", "err");
    return false;
  }
}

/* ------------------------------------------------------------------ Modals */

// Open one modal at a time; track the element to focus on close.
function openModal(render) {
  const previouslyFocused = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let settled = false;
  const close = (result, resolve) => {
    if (settled) return;
    settled = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    resolve(result);
  };

  return new Promise((resolve) => {
    const focusables = () =>
      modal.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])');

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); render.onCancel(); return; }
      if (e.key === "Tab") {
        const items = Array.from(focusables());
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    render.build(modal, {
      resolve: (v) => close(v, resolve),
    });
    render.onCancel = render.onCancel || (() => close(render.cancelValue, resolve));

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) render.onCancel();
    });
    document.addEventListener("keydown", onKey, true);

    (render.initialFocus?.(modal) || modal.querySelector("button, input"))?.focus();
  });
}

let modalSeq = 0;

/** Accessible confirmation dialog → resolves true (confirm) / false (cancel). */
export function confirmDialog({
  title = "Confirmer",
  message = "",
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  danger = false,
} = {}) {
  const id = `m${++modalSeq}`;
  const render = {
    cancelValue: false,
    build(modal, { resolve }) {
      modal.setAttribute("aria-labelledby", `${id}-t`);
      modal.innerHTML = `
        <h3 id="${id}-t"></h3>
        <p id="${id}-m"></p>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" data-cancel></button>
          <button type="button" data-confirm></button>
        </div>`;
      modal.setAttribute("aria-describedby", `${id}-m`);
      modal.querySelector(`#${id}-t`).textContent = title;
      modal.querySelector(`#${id}-m`).textContent = message;
      const cancelBtn = modal.querySelector("[data-cancel]");
      const confirmBtn = modal.querySelector("[data-confirm]");
      cancelBtn.textContent = cancelLabel;
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className = danger ? "btn-danger" : "";
      cancelBtn.addEventListener("click", () => resolve(false));
      confirmBtn.addEventListener("click", () => resolve(true));
      render.onCancel = () => resolve(false);
    },
    // Focus the safe (cancel) action by default.
    initialFocus: (modal) => modal.querySelector("[data-cancel]"),
  };
  return openModal(render);
}

/** Accessible text-input dialog → resolves the string, or null on cancel. */
export function promptDialog({
  title = "Saisie",
  label = "",
  value = "",
  placeholder = "",
  maxlength = 100,
  confirmLabel = "Valider",
  cancelLabel = "Annuler",
} = {}) {
  const id = `m${++modalSeq}`;
  const render = {
    cancelValue: null,
    build(modal, { resolve }) {
      modal.setAttribute("aria-labelledby", `${id}-t`);
      modal.innerHTML = `
        <h3 id="${id}-t"></h3>
        <label for="${id}-i"><span></span>
          <input id="${id}-i" type="text">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" data-cancel></button>
          <button type="button" data-confirm></button>
        </div>`;
      modal.querySelector(`#${id}-t`).textContent = title;
      modal.querySelector("label span").textContent = label;
      const input = modal.querySelector("input");
      input.value = value;
      input.placeholder = placeholder;
      input.maxLength = maxlength;
      const cancelBtn = modal.querySelector("[data-cancel]");
      const confirmBtn = modal.querySelector("[data-confirm]");
      cancelBtn.textContent = cancelLabel;
      confirmBtn.textContent = confirmLabel;
      const submit = () => resolve(input.value);
      cancelBtn.addEventListener("click", () => resolve(null));
      confirmBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      render.onCancel = () => resolve(null);
    },
    initialFocus: (modal) => {
      const i = modal.querySelector("input");
      i.setSelectionRange?.(i.value.length, i.value.length);
      return i;
    },
  };
  return openModal(render);
}
