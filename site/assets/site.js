// Shared by every page: language (es/en), install box, latest release, docs table of contents.
(() => {
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem("ob-lang"); } catch { return null; } })();
  const fromUrl = new URLSearchParams(location.search).get("lang");
  let lang = fromUrl || saved || ((navigator.language || "es").toLowerCase().startsWith("es") ? "es" : "en");
  if (lang !== "es" && lang !== "en") lang = "es";
  const RAW = "https://raw.githubusercontent.com/Lautaro005/openblocks/main";
  const T = {
    es: { copy: "Copiar", copied: "¡Copiado!", unix: "Instala la app (en macOS, en Aplicaciones) y el comando openblocks.", win: "En PowerShell. Instala la app para tu usuario y el comando openblocks.", dl: (ext, tag) => `Descargar ${ext} · ${tag}`, latest: (t) => `Última versión: ${t}` },
    en: { copy: "Copy", copied: "Copied!", unix: "Installs the app (on macOS, in Applications) and the openblocks command.", win: "In PowerShell. Installs the app for your user and the openblocks command.", dl: (ext, tag) => `Download ${ext} · ${tag}`, latest: (t) => `Latest version: ${t}` },
  };
  const listeners = [];
  const setLang = (l) => {
    lang = l;
    root.lang = l;
    try { localStorage.setItem("ob-lang", l); } catch {}
    document.querySelectorAll("[data-set-lang]").forEach((b) => b.classList.toggle("on", b.dataset.setLang === l));
    const title = document.querySelector(`meta[name="title-${l}"]`);
    if (title) document.title = title.content;
    listeners.forEach((f) => f());
  };
  document.querySelectorAll("[data-set-lang]").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.setLang)));

  const isWin = /Windows/i.test(navigator.userAgent);
  const cmds = { unix: `curl -fsSL ${RAW}/install.sh | sh`, win: `irm ${RAW}/install.ps1 | iex` };
  document.querySelectorAll("[data-install]").forEach((box) => {
    let os = isWin ? "win" : "unix";
    const copy = box.querySelector("[data-copy]");
    const render = () => {
      box.querySelectorAll("[data-os]").forEach((b) => b.classList.toggle("on", b.dataset.os === os));
      box.querySelector("[data-cmd]").textContent = cmds[os];
      const note = box.querySelector("[data-note]");
      if (note) note.textContent = T[lang][os];
      box.querySelector(".p").textContent = os === "win" ? ">" : "$";
      copy.textContent = T[lang].copy;
    };
    box.querySelectorAll("[data-os]").forEach((b) => b.addEventListener("click", () => { os = b.dataset.os; render(); }));
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(cmds[os]); copy.textContent = T[lang].copied; setTimeout(() => (copy.textContent = T[lang].copy), 1500); } catch {}
    });
    listeners.push(render);
  });

  // Latest release: point the download link at this system's installer.
  const dl = document.querySelector("[data-download]");
  const ver = document.querySelectorAll("[data-version]");
  if (dl || ver.length) {
    let rel = null, asset = null;
    const paint = () => {
      if (!rel) return;
      if (dl && asset) { dl.href = asset.browser_download_url; dl.textContent = T[lang].dl(asset.name.split(".").pop().toUpperCase(), rel.tag_name); }
      ver.forEach((v) => (v.textContent = T[lang].latest(rel.tag_name)));
    };
    fetch("https://api.github.com/repos/Lautaro005/openblocks/releases/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => {
        if (!r) return;
        rel = r;
        const ua = navigator.userAgent;
        const want = /Windows/i.test(ua) ? /x64-setup\.exe$/ : /Mac/i.test(ua) ? /\.dmg$/ : /\.AppImage$/;
        asset = (r.assets || []).find((a) => want.test(a.name));
        paint();
      })
      .catch(() => {});
    listeners.push(paint);
  }

  // Nav border on scroll.
  const nav = document.querySelector(".nav");
  const onScroll = () => nav && nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Docs: highlight the section on screen.
  const toc = document.querySelectorAll(".toc a");
  // English sections use "<id>-en" anchors.
  const fixToc = () => toc.forEach((a) => {
    const base = (a.dataset.id ||= a.getAttribute("href").slice(1));
    const id = lang === "en" && document.getElementById(base + "-en") ? base + "-en" : base;
    a.setAttribute("href", "#" + id);
  });
  listeners.push(fixToc);
  fixToc();
  if (toc.length) {
    const map = new Map([...toc].map((a) => [a.dataset.id, a]));
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) {
          toc.forEach((a) => a.classList.remove("on"));
          map.get(e.target.id)?.classList.add("on");
        }
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    toc.forEach((a) => {
      const base = a.dataset.id;
      map.set(base + "-en", a);
      [base, base + "-en"].forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    });
  }

  setLang(lang);
})();
