#!/usr/bin/env python3
"""
Workaround for anthropic.claude-code extension v2.1.x bug:
https://github.com/anthropics/claude-code/issues/51677

The extension's webview CSS embeds the codicon font as `url(data:font/ttf;base64,…)`
inside an `@font-face`, but VS Code's webview CSP forbids `data:` in `font-src`,
so glyphs render as empty squares.

Workaround: extract the base64 to a sibling `codicon.ttf` in the webview folder
and rewrite the @font-face to load it via a relative URL. Inside the webview the
relative URL resolves under `vscode-webview://…/webview/codicon.ttf`, which IS
allowed by the default CSP (`font-src 'self'`).

Idempotent: re-runs find no remaining data: URI and become a no-op.
"""
import base64, pathlib, re, sys

ext_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                       else "/home/coder/.local/share/code-server/extensions")

CODICON_FONT_FACE_RE = re.compile(
    r"@font-face\s*\{[^{}]*font-family\s*:\s*[\"']?codicon[\"']?[^{}]*"
    r"url\(\s*data:font/(?:ttf|woff2|woff);base64,(?P<b64>[A-Za-z0-9+/=]+)\s*\)"
    r"[^{}]*\}",
    re.IGNORECASE,
)
DATA_URL_RE = re.compile(
    r"url\(\s*data:font/(?:ttf|woff2|woff);base64,[A-Za-z0-9+/=]+\s*\)",
    re.IGNORECASE,
)

patched = 0
for css in ext_dir.glob("anthropic.claude-code-*/webview/index.css"):
    text = css.read_text(encoding="utf-8")
    m = CODICON_FONT_FACE_RE.search(text)
    if not m:
        print(f"  {css.relative_to(ext_dir)}: no codicon data: URI (already patched?)")
        continue
    (css.parent / "codicon.ttf").write_bytes(base64.b64decode(m["b64"]))
    new_block = DATA_URL_RE.sub("url(codicon.ttf)", m.group(0), count=1)
    css.write_text(text.replace(m.group(0), new_block), encoding="utf-8")
    print(f"  {css.relative_to(ext_dir)}: extracted codicon.ttf "
          f"({(css.parent / 'codicon.ttf').stat().st_size} bytes), CSS rewritten")
    patched += 1

if not patched:
    print("Nothing to patch.")
    sys.exit(0)
print(f"Patched {patched} CSS file(s). Hard-refresh the browser to pick up the change.")
