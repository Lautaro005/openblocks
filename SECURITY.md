# Security Policy

OpenBlocks reads and writes the files of your vault, runs a local HTTP server, starts AI agents that can edit your
pages and installs and updates itself, so security reports are taken seriously and handled privately.

## Supported versions

| Version | Supported |
|---|---|
| Latest release (`0.1.x`) | ✅ |
| Older | ❌ — please update first (`openblocks update`) |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for security problems.**

Report privately through GitHub: the repository's **Security** tab →
[**Report a vulnerability**](https://github.com/Lautaro005/openblocks/security/advisories/new).

Please include the version (`openblocks --version`), your operating system, how you installed OpenBlocks, steps to
reproduce and the impact you expect. Remove API keys, page contents and personal data from logs.

- Acknowledgement within **7 days**, an initial assessment within **14 days**
- A fix or mitigation plan for confirmed issues, coordinated with you before disclosure (90 days by default)
- Credit in the advisory and release notes, if you want it

## Security model

- **Loopback only.** The server binds to `127.0.0.1` (port 47880 by default). It rejects requests whose `Host` header
  is not `127.0.0.1`, `localhost` or `[::1]` on that port (DNS rebinding), and every request that changes something
  must carry the `X-OpenBlocks: 1` header, which a web page cannot send cross-origin without a CORS preflight the
  server never approves.
- **Paths stay inside the vault.** Every path from the UI, the API or an agent is resolved against the vault root;
  absolute paths, `..` and the `.openblocks` folder are refused. Files from the vault are served with
  `Content-Security-Policy: sandbox` and HTML is served as plain text, so a note or attachment cannot run scripts in the
  app (HTML artifacts, below, run only in an isolated frame). Rendered Markdown escapes raw HTML, and links open in your system browser, never inside the app window.
- **Agents can be undone.** AI agents can only use the tools OpenBlocks gives them (search, read, list, backlinks,
  create, edit, set property, and — only when you turn them on — web search/fetch, brain and Lumina search). Every edit
  keeps a history copy first and shows an Undo card. You can make agents read-only in Settings → AI. Content an agent
  reads (a web page, a document) can try to steer it (prompt injection); keep edits reviewable and read-only mode on if
  you work with untrusted material.
- **CLI agents run with your account.** Claude Code and Codex run as your user with OpenBlocks' MCP server as their only
  tool source (`--tools ""` / read-only sandbox); their permissions are those of the CLI you installed.
- **Secrets.** API keys are stored in `~/.openblocks/settings.json` with mode `0600` and are never sent to the UI (it
  only learns whether a key is set). They are sent only to the provider they belong to.
- **Family apps.** brain, Lumina and OpenCue are reached on `127.0.0.1` or through their own command and MCP server.
  OpenBlocks reads OpenCue's agent list read-only and writes only its own entry in `~/.workstudio/apps.json` (keeping a
  `.bak-openblocks` copy) when you ask it to.
- **Remote access by URL** (`crates/core/src/remote.rs`): off by default. When on, a second listener on `127.0.0.1:47890`
  serves only MCP, and `cloudflared` publishes it. Every request needs the secret token, in the path (`/<token>/mcp`)
  or as `Authorization: Bearer <token>` on `/mcp`, compared in constant time; without it the answer is `404`. The app's
  own API is never published. Regenerating the token cuts off the old URL at once; read-only mode hides and refuses
  every tool that changes the vault. The token and the tunnel token live in `~/.openblocks/remote.json` (`0600`) and
  the token is masked in the tunnel log. `cloudflared` is taken from your PATH or downloaded from Cloudflare's
  official GitHub release and checked against the SHA256 Cloudflare publishes. A way to call a tool without the token,
  to get around read-only, or to reach the app's API through the tunnel is a vulnerability.
- **Local models.** Gemma 4 and EmbeddingGemma 2 run in `llama-server` processes bound to `127.0.0.1` on a random port.
  OpenBlocks uses Lumina's `llama-server` and models when they are installed; otherwise it downloads llama.cpp from
  its official GitHub release and the models from Hugging Face (`ggml-org`) to `~/.openblocks/models`. Scanned PDFs
  are opened in a child process so a broken file cannot crash the app.
- **Importing from Notion** (`crates/core/src/import/`). The integration token is held in memory for one import, sent
  only to `api.notion.com` and never saved or logged. Files Notion hosts are downloaded from the signed links its API
  returns. A `.zip` export is unpacked into a temporary folder with every entry checked to stay inside it (no `..` or
  absolute paths), then deleted; nothing is written outside the new destination folder of the vault, and imported
  Markdown is treated like any other page (raw HTML is escaped when rendered).
- **Updates and installers.** `openblocks update` and the in-app update button run the official installer from this
  repository, which downloads the latest GitHub Release. The macOS app is signed with the project's own certificate
  (a stable identity so macOS keeps permissions across updates) but not notarized by Apple; Windows installers are
  not code-signed yet.
- **Find and replace** runs entirely in the page: matches and replacements go through the editor (undoable, saved like
  any edit) and regular expressions are evaluated by the browser engine on the page's own text only.
- **HTML artifacts** (`crates/core/src/artifact.rs`). An `.html` file you open as an artifact (or embed with
  `![[file.html]]`) does run its scripts, so it is isolated twice: the frame has the `sandbox` attribute and the page is
  served with `Content-Security-Policy: sandbox allow-scripts` (an opaque origin: no cookies, storage or access to the
  app), `connect-src 'none'` (no `fetch`, XHR or WebSocket to the app's API, your network or the internet),
  `form-action 'none'` and `frame-src 'none'`. Scripts and styles may load only from jsDelivr, cdnjs, unpkg and esm.sh;
  images only from the page itself and from the local server's file route, which it cannot read back. Spreadsheet data
  reaches the page only because the app reads the files the artifact names in its `openblocks-data` meta tag and writes
  them into the page before serving it. Every other `.html` in the vault is still served as plain text. An artifact you
  did not write is code from someone else: open its Code view first if you are unsure.
- **Spreadsheets** are read and written in Rust (calamine, rust_xlsxwriter) inside the vault; formulas are evaluated by
  the app's own small engine in the page, never with `eval`.
- **PDFs** are drawn by pdf.js inside the app (the PDF's own JavaScript and forms are not run); its worker, character
  maps and fonts are bundled with the app, so nothing is downloaded.
- **Symbolic links.** A symlink inside your vault is followed like any file. Do not put links to folders you would not
  want an agent to read inside a vault.

## Scope

In scope: a web page, file or note reaching the local API or running code in the app; path traversal out of the vault;
API keys leaking to the UI, logs or a provider they do not belong to; an agent editing without leaving a history copy;
the installers running anything other than the official release; a Notion import writing outside its destination
folder, or the Notion token being stored, logged or sent anywhere but Notion; an HTML artifact reaching the local API,
the network beyond the allowed CDNs, the vault's files or the app's window.

Out of scope: what a model or provider does with what you send it (see their policies), what the family apps do by
themselves (report it to their repositories), and anything that needs an attacker who already runs code as your user.
