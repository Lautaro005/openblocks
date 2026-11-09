# Changelog

All notable changes to OpenBlocks. Dates are YYYY-MM-DD.

## [0.1.3] — 2026-11-09

### HTML artifacts
- **HTML files are now artifacts you see inside the app**, like Claude's: open one and switch between **View** (the page
  running) and **Code** (an editor with syntax colors, line numbers, indentation and `⌘S`). New ones from the sidebar,
  a folder's right-click menu or the palette: *New HTML artifact*.
- **Spreadsheets as data.** The **Data** button links one or more spreadsheets (`.xlsx`, `.csv`…) to an artifact; the
  page reads them with `openblocks.table()` (rows keyed by the header row), `openblocks.rows()`, `openblocks.sheets()`
  and `openblocks.files`, with numbers as numbers. Edit the spreadsheet and the artifact updates. The link is a
  `<meta name="openblocks-data">` tag in the file, so it travels with it.
- **Embedded in pages:** `![[Panel.html]]` shows the artifact running inside the page; drag its bottom edge to change
  its height (kept as `![[Panel.html|420]]`).
- **The AI makes them:** agents have `write_artifact` (a whole HTML page, with its spreadsheets linked) and
  `write_spreadsheet`, so "make me a dashboard of these sales" ends in an artifact and a spreadsheet you can edit.
  Undo works for both.
- Artifacts run **sandboxed**: no access to the app, your vault, your files or the network. They can load libraries
  from the usual CDNs (jsDelivr, cdnjs, unpkg, esm.sh) and nothing else.

### Spreadsheet editor
- `.xlsx`, `.csv` and `.tsv` open in an editor of their own: click a cell and type, `Enter`/`Tab`/arrows to move,
  `Shift` to select a range, `Delete` to clear, copy and paste with other spreadsheets, `⌘Z` to undo, rows, columns and
  sheets from the headers' and tabs' menus. Saved on its own a moment after you stop.
- **Formulas** with `=`: references, ranges, arithmetic and the common functions in English or Spanish
  (`SUM`/`SUMA`, `AVERAGE`/`PROMEDIO`, `IF`/`SI`, `ROUND`/`REDONDEAR`, `COUNT`, `MIN`, `MAX`, `CONCAT`…), computed as
  you type and saved as real formulas in the `.xlsx` (with their results). Values and formulas are kept; cell
  formatting is not. `.xls` and `.ods` open read-only, with a button to save an `.xlsx` copy.

### Editor
- **Columns like Notion's, up to 4:** `/2 columnas`, `/3`, `/4` (or "Columns" in a block's menu), or drag a block by
  its handle to the left or right edge of another one. Drag the line between two columns to change their widths
  (double-click resets them). Backspace in an empty column removes it, and a single column left goes back to plain
  blocks. Blocks inside columns have their own handle to move them in, out and between columns.
- **Toggle headings** (`/Título desplegable 1–3`, or *Toggle heading* in a block's menu): a toggle whose title is a
  heading. Stored as `<details data-heading="2">`.
- **Heading 4** (`####`, `/Título 4`, `⌘⌥4`).

### Settings → Appearance
- A new section to make the app yours: theme (system, light, dark), **palette** (warm, neutral, sepia, high contrast —
  each in light and dark), **accent color** (seven or any other), **fonts** for the page text (Source Sans, system,
  serif, mono or any font installed on your computer), headings and the interface, **text size**, **line spacing**,
  page width (normal, wide, full) and the **size of the whole interface** (also `⌘+`, `⌘−`, `⌘0`).

### Fixed
- **PDFs showed a dark gray box.** The webview's PDF viewer does not work inside the app (and Linux has none), so
  OpenBlocks now draws PDFs itself with pdf.js: pages as you scroll, zoom (buttons, fit to width, pinch or ⌘+wheel),
  go to page, and text you can select and copy.
- **Zooming the graph was too sensitive** on trackpads: zoom now follows how far you scroll or pinch, toward the
  pointer, and there are − / % / + buttons.
- The floating sidebar (hidden sidebar, mouse on the left edge) had empty space above the vault name on macOS.
- In Settings → AI, the model list opened past the window and made it scroll sideways.

## [0.1.2] — 2026-11-08

### Fixed
- **Links, search and the graph lost pages from big folders.** When macOS reported a change on a folder (after
  an import, or Finder touching it), the index dropped every page inside it: links to those pages created new empty
  pages instead of opening them, search found nothing and the graph was empty. Folder changes now re-read the folder,
  and the index rebuilds itself when the system drops events. Clicking a link also falls back to the sidebar's list of
  pages, so it never creates a page that already exists.
- "Copy link" in the ⋯ menu writes the page's full path when another page has the same name (common in Notion
  imports), so the link always opens the right page.

### Sidebar
- Drag its edge to make it wider or narrower (double-click to reset); the width is remembered.
- With the sidebar hidden, move the mouse to the left edge of the window (or over the show button) and it appears
  floating over the page; it hides again when the mouse leaves. The button in it pins it back.
- Clicking a folder's **name** (underlined on hover) opens it: its own page when it has one with the same name — as
  pages with subpages come from Notion — or the folder view. Clicking the rest of the row expands or collapses it.
  **Open** is the first option of the right-click menu, followed by Expand/Collapse.

### Folders
- The folder view sorts by name, last edit or type (ascending or descending) or by hand — drag the items into the
  order you want — and shows a list or a grid of cards with item counts and dates. Saved per folder.

### Editor
- **Find and replace** with `⌘F` / `Ctrl+F` (`⌘⌥F` / `Ctrl+H` opens it with replace): matches highlighted in the page,
  `↵`/`⇧↵` to move between them, match case, whole word and regular expressions (with `$1` in replacements),
  replace one or all, delete every match, or delete the blocks that contain them. Each action is one undo step.
- **Select blocks like files on a desktop:** press outside the text (the page margins, under the last block) and drag a
  rectangle. Every block it touches is selected: delete or cut them, copy, format them, or ask the AI. `Esc` clears it.

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
