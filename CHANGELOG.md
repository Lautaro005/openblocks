# Changelog

All notable changes to OpenBlocks. Dates are YYYY-MM-DD.

## [0.1.1] — 2026-11-03

### Import from Notion
- New **Settings → Import**: bring a whole Notion workspace into a folder of the vault, two ways.
  - **With a token (recommended):** create an internal integration in Notion, pick the pages it can see and paste
    its secret. OpenBlocks reads every page and database through the Notion API — subpages, pages inside toggles
    and columns, every database row, typed properties and the files Notion hosts — and the token is not saved.
  - **With the export:** drop the `.zip` from Notion's "Markdown & CSV" export (zips of zips and several parts work
    too), or choose the folder your browser unzipped.
- Both end the same way: Notion's ids leave the names, a page with subpages becomes a folder with the page inside,
  databases become database folders (one page per row, properties in the frontmatter as dates, checkboxes, numbers,
  lists and links), links between pages become `[[wikilinks]]`, images and files are embedded, callouts, toggles,
  tables, code and equations keep their shape.
- A progress bar with what is being copied, Cancel, and a list of what could not be brought over.
- Links to a folder (like an imported database) now open the folder.

### macOS
- The app is now properly code-signed. Before, the bundle had no signature, so macOS could not remember the
  permission to read a vault on a USB or external drive and asked again and again when the app opened. Now it asks
  once, and the answer sticks — also across updates, because every release is signed with the same OpenBlocks
  certificate (it is not an Apple notarization: the first launch of a downloaded `.dmg` still needs right-click → Open).

## [0.1.0] — 2026-11-02

The first release: block notes on your own Markdown folder, with AI agents that use your own models.

### Vault
- Any folder is a vault: pages are `.md` files, Obsidian-compatible (`[[links]]`, `![[embeds]]`, `#tags`, YAML properties, `> [!note]` callouts, `- [ ]` tasks, `==highlights==`).
- First-run tour: language and theme, vault folder (native picker), organization name, AI model and the WorkStudio family.
- Switch between vaults; open an existing Obsidian vault as is.
- Changes made by other programs (Obsidian, an editor, a sync tool, an agent over MCP) show up at once.

### Editor
- Block editor: headings, lists, tasks, quotes, callouts with eight types, toggles, highlighted code, tables, dividers.
- `/` menu, `[[` page links (creating missing pages), Markdown shortcuts as you type, paste Markdown as blocks.
- Block handle to drag blocks, insert below, turn into, duplicate, copy as Markdown or ask the AI.
- Selection toolbar with formatting and AI actions (improve, fix, shorten, expand, summarize, tasks, table, translate, explain, or any instruction).
- Page properties editor (text, number, date, checkbox, lists) and daily notes.
- Templates in Settings → Templates: pick the default one for every new page, create and edit your own (pages in a templates folder with `{{title}}`, `{{date}}`, `{{time}}`), save the open page as a template, or start from examples.
- `⌘.` (Ctrl+. on Windows and Linux, configurable in Settings → Shortcuts) opens a box under the line to tell the AI what to write or change there, with the whole page as context.
- Autosave with conflict detection when the file changed on disk.

### Files, databases and links
- Drop or paste files: they go to an `attachments` folder and appear as blocks; images, audio and video play inline; pages can be embedded.
- Local previews on the side or in a floating window: PDF, Word (.docx), Excel (.xlsx/.xls/.ods), CSV/TSV, PowerPoint (.pptx), images with zoom, audio, video, Markdown and code.
- Any folder as a database: table (edit, sort, hide, add columns) or board grouped by a property, stored in each page's frontmatter.
- Backlinks and unlinked mentions, a force-directed graph (local graph, missing links), tag pages.
- Renaming or moving a page or folder rewrites every link to it.
- Full-text search and command palette (`⌘K`), quick switcher (`⌘P`), favorites, recent pages.

### History and trash
- Page history: a copy every ten minutes of editing and before every AI change; restore any version.
- Trash inside the vault with restore; empty it to delete for good.

### AI
- Chat panel (`⌘J`) with Ollama, LM Studio, Claude Code, Codex, Anthropic, OpenAI-compatible APIs, OpenRouter and OpenCue agents.
- Agents search, read, create, edit, rename, move and delete pages, files and folders, and set properties; every change has an Undo card (deletes go to the trash); read-only mode.
- Attach files to the chat (PDF, Word, Excel, PowerPoint, CSV, text, HTML): the agent reads them and can turn them into pages or keep the file in the vault.
- Context from the open page and `@` mentions; Web, brain and Lumina search pills; reasoning and tool steps shown; conversations saved per vault.
- OpenCue agents run inside OpenBlocks with their own model, instructions and memory, and the same vault tools (agents whose model needs a key only OpenCue has are reached through OpenCue).
- Gemma 4 runs on your computer as a chat model that needs nothing else, and reads the text of images and scanned PDFs (attached in the chat or in the vault) for every agent; EmbeddingGemma 2 finds images in the vault by what they show (`find_images`). Both run with llama.cpp, using Lumina's llama.cpp and Gemma 4 when Lumina is installed; Settings → AI → Local models downloads what is missing.
- `openblocks mcp`: the vaults as an MCP server for Claude Code, Codex, Cursor, Claude Desktop and AI WorkStudio — the open vault or all of them (`--all`, `--vault`, or the choice in Settings → Family).
- Remote access by URL: the MCP server published with a Cloudflare tunnel (quick tunnel or your own domain), behind a secret token, with read-only mode, token regeneration and automatic reconnection; `cloudflared` is installed from Cloudflare's release with its SHA256 checked.

### WorkStudio family
- Register OpenBlocks in AI WorkStudio (home card, embedded view, `openblocks__*` tools in its single MCP server).
- Search brain and Lumina from the chat; save a page to brain; send a page to an OpenCue agent.

### App
- Rust core (axum, notify, calamine, quick-xml) and Tauri 2 desktop shell; `openblocks serve` runs it in any browser.
- Spanish and English, light and dark themes, keyboard shortcuts, print or save as PDF, export to Markdown and HTML.
- One-line installers for macOS, Linux and Windows; `openblocks update` and `openblocks uninstall`.
- Website with docs, privacy policy, changelog and `llms.txt`.
