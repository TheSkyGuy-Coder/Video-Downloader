// Steuerung: Tab finden, Quellen aufbauen, Ansichten rendern.
(async function () {
  "use strict";
  const { h, bgCall, store } = Dom;
  const S = Shared;
  const C = Cmd;

  const mode = document.documentElement.dataset.mode === "popup" ? "popup" : "tab";
  document.body.classList.add("mode-" + mode);
  const root = document.getElementById("app");

  const app = {
    mode, view: "builder", tabId: null, tab: { url: "", title: "" }, tabsList: [],
    snap: { entries: [], log: [], counts: {}, capture: true, pageUrl: "" },
    sources: [], selected: null, src: null, userPicked: false,
    model: Object.assign({}, C.DEFAULT_MODEL), userPresets: [], names: {},
    savingPreset: false, advOpen: false, hintsOpen: false, mask: true, errors: [], sig: "",
  };

  function showErr(msg) {
    if (app.errors.indexOf(msg) < 0) app.errors.push(msg);
    if (app.errors.length > 4) app.errors.shift();
    const box = document.querySelector(".errbox");
    if (box) box.textContent = app.errors.join("\n");
    else if (root) render();
  }
  window.addEventListener("error", (ev) => showErr("Fehler: " + ev.message));
  window.addEventListener("unhandledrejection", (ev) => showErr("Fehler: " + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason)));

  // ---------- Modell speichern ----------
  let saveTimer = null;
  function saveModel() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set("model2", C.persistable(app.model)), 300);
  }

  // ---------- Quellen ----------
  const ytLabel = (yt) => ({ video: "YouTube-Video", shorts: "YouTube Short", playlist: "YouTube-Playlist", channel: "YouTube-Kanal" }[yt.type] || "YouTube");
  const shorten = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

  function buildSources() {
    const list = [];
    const url = app.tab.url || "";
    if (/^https?:/i.test(url)) {
      const yt = S.parseYouTube(url);
      list.push({
        id: "page", kind: "page", url, site: yt ? "youtube" : null, yt, icon: "▶",
        title: yt ? ytLabel(yt) : "Diese Seite",
        sub: yt ? S.cleanTitle(app.tab.title) || S.shortUrl(url) : "yt-dlp sucht das Video selbst (viele Seiten werden erkannt)",
        referer: null, ua: null, origin: null, playlist: null, priority: yt ? 100 : 10,
      });
    }
    (app.snap.entries || []).slice().reverse().forEach((e) => {
      if (e.via === "youtube-embed") {
        list.push({
          id: e.url, kind: "page", url: e.url, site: "youtube", yt: S.parseYouTube(e.url), icon: "▶",
          title: "YouTube (eingebettet)", sub: S.shortUrl(e.url),
          referer: app.snap.pageUrl || url || null, ua: null, origin: null, playlist: null, priority: 90,
        });
        return;
      }
      const pl = e.playlist;
      const okStatus = e.status == null || (e.status >= 200 && e.status < 300);
      const invalid = !!(pl && !pl.valid);
      let what = "Stream";
      if (e.via === "direct") what = "Videodatei";
      else if (/\.mpd(\?|#|$)/i.test(e.url)) what = "DASH-Manifest";
      else if (invalid) what = "Keine gültige Playlist";
      else if (pl && pl.valid) what = pl.kind === "master" ? "Master-Playlist" : pl.kind === "media" ? "Medien-Playlist" : "Playlist";
      let sub = S.shortUrl(e.url);
      if (pl && pl.valid && pl.kind === "master") sub += " · " + S.variantSummary(pl);
      list.push({
        id: e.url, kind: "stream", url: e.url, site: null, yt: null, icon: "≋", title: what, sub,
        badge: S.statusText(e), badgeClass: S.statusClass(e),
        referer: (e.reqHeaders && e.reqHeaders.referer) || app.snap.pageUrl || url || null,
        ua: (e.reqHeaders && e.reqHeaders["user-agent"]) || null,
        origin: (e.reqHeaders && e.reqHeaders.origin) || null,
        playlist: pl || null, entry: e,
        priority: !okStatus || invalid ? 3 : pl && pl.valid && pl.kind === "master" ? 70 : 50,
      });
    });
    app.sources = list;
    const keep = app.userPicked ? list.find((s) => s.id === app.selected) : null;
    if (keep) applySource(keep.id);
    else {
      app.userPicked = false;
      let best = null;
      list.forEach((s) => {
        if (!best || s.priority > best.priority) best = s;
      });
      applySource(best ? best.id : null);
    }
  }

  function applySource(id) {
    const s = app.sources.find((x) => x.id === id) || null;
    const changed = (s ? s.id : null) !== app.selected;
    app.src = s;
    app.selected = s ? s.id : null;
    if (!s) return;
    const m = app.model;
    if (changed) {
      m.playlist = C.defaultPlaylist(s);
      m.ffVariant = "auto";
      m.start = "";
      m.end = "";
      if (s.kind === "page") m.tool = "ytdlp";
    }
    if (app.names[s.id] != null) m.name = app.names[s.id];
    else m.name = s.kind === "page" ? "%(title)s" : S.safeName(S.cleanTitle(app.tab.title)) || "video";
  }

  // ---------- Daten holen ----------
  async function refresh() {
    if (app.tabId == null) return false;
    let tab = { url: "", title: "" };
    try {
      tab = await browser.tabs.get(app.tabId);
    } catch (_) {}
    const snap = await bgCall({ type: "get", tabId: app.tabId });
    let tl = null;
    if (mode === "tab") {
      const res = await Promise.all([browser.tabs.query({}), bgCall({ type: "all" })]);
      const counts = new Map(res[1].map((a) => [a.tabId, a.count]));
      tl = res[0]
        .filter((t) => /^https?:/i.test(t.url || ""))
        .map((t) => ({ id: t.id, title: t.title, url: t.url, count: counts.get(t.id) || 0 }));
    }
    const sig = JSON.stringify([
      tab.url, tab.title,
      snap.entries.map((e) => [e.url, e.status, e.hits, e.completed, e.bodyBytes, e.error, e.refetch && e.refetch.at, e.playlist && e.playlist.kind, !!e.reqHeaders]),
      snap.log.length, snap.capture,
      tl && tl.map((t) => [t.id, t.title, t.count]),
    ]);
    const changed = sig !== app.sig;
    app.sig = sig;
    app.tab = tab;
    app.snap = snap;
    if (tl) app.tabsList = tl;
    if (changed) buildSources();
    return changed;
  }

  async function poll() {
    try {
      if (!(await refresh())) return;
      const a = document.activeElement;
      const typing = a && ((a.tagName === "INPUT" && a.type === "text") || a.tagName === "TEXTAREA");
      if (typing && app.view === "builder") Builder.updateCommand(app, hooks);
      else render();
    } catch (err) {
      showErr("Aktualisieren fehlgeschlagen: " + (err && err.message ? err.message : err));
    }
  }

  // ---------- Aktionen ----------
  const hooks = {
    change() {
      saveModel();
      render();
    },
    text() {
      saveModel();
      Builder.updateCommand(app, hooks);
    },
    selectSource(id) {
      app.userPicked = true;
      applySource(id);
      saveModel();
      render();
    },
    applyPreset(pm) {
      Object.assign(app.model, pm);
      if (app.src && app.src.kind === "page" && app.model.tool === "ffmpeg") app.model.tool = "ytdlp";
      saveModel();
      render();
    },
    startSavePreset() {
      app.savingPreset = true;
      render();
    },
    cancelSavePreset() {
      app.savingPreset = false;
      render();
    },
    savePreset(name) {
      name = String(name || "").trim();
      if (!name) return;
      const pm = C.pickKeys(app.model, C.PRESET_KEYS);
      const i = app.userPresets.findIndex((p) => p.name === name);
      if (i >= 0) app.userPresets[i] = { name, model: pm };
      else app.userPresets.push({ name, model: pm });
      app.savingPreset = false;
      store.set("presets2", app.userPresets);
      render();
    },
    deletePreset(i) {
      app.userPresets.splice(i, 1);
      store.set("presets2", app.userPresets);
      render();
    },
    useInBuilder(url) {
      app.userPicked = true;
      applySource(url);
      app.view = "builder";
      saveModel();
      render();
    },
    async refetch(url) {
      await bgCall({ type: "refetch", tabId: app.tabId, url });
      await refresh();
      render();
    },
    async clear() {
      await bgCall({ type: "clear", tabId: app.tabId });
      await refresh();
      render();
    },
    async setCapture(v) {
      await bgCall({ type: "setCapture", value: v });
      await refresh();
      render();
    },
    setMask(v) {
      app.mask = v;
      store.set("mask", v);
    },
  };

  // ---------- Darstellung ----------
  async function openTab(view) {
    await browser.tabs.create({ url: browser.runtime.getURL("app.html?view=" + view + (app.tabId != null ? "&tab=" + app.tabId : "")) });
    window.close();
  }

  function tabSelect() {
    const sel = h(
      "select",
      {
        class: "tabsel",
        onchange: async () => {
          app.tabId = parseInt(sel.value, 10);
          app.userPicked = false;
          app.selected = null;
          app.sig = "";
          await refresh();
          render();
        },
      },
      app.tabsList.map((t) => h("option", { value: t.id, selected: t.id === app.tabId, text: (t.count ? "(" + t.count + ") " : "") + shorten(t.title || t.url, 48) }))
    );
    return h("label", { class: "tabpick" }, h("span", { text: "Tab:" }), sel);
  }

  function header() {
    const navBtn = (label, view) =>
      h("button", {
        type: "button", class: "navbtn", "aria-pressed": String(app.view === view), text: label,
        onclick: () => {
          if (mode === "popup" && view === "debug") return openTab("debug");
          app.view = view;
          render();
        },
      });
    const kids = [h("strong", { class: "title", text: "m3u8 → yt-dlp" }), h("div", { class: "nav" }, navBtn("Baukasten", "builder"), navBtn("Debug", "debug"), navBtn("Helfer", "helper"))];
    kids.push(h("span", { class: "spacer" }));
    if (mode === "popup") kids.push(h("button", { type: "button", class: "btn small", text: "⤢ Groß öffnen", onclick: () => openTab("builder") }));
    else kids.push(tabSelect());
    return h("header", { class: "top" }, ...kids);
  }

  function render() {
    root.replaceChildren();
    root.appendChild(header());
    if (app.errors.length) root.appendChild(h("div", { class: "errbox", text: app.errors.join("\n") }));
    if (app.view === "helper") {
      root.appendChild(HelperView.render(app, hooks));
      return;
    }
    if (app.tabId == null) {
      root.appendChild(h("p", { class: "empty", text: "Kein Tab mit einer Webseite gefunden. Öffne eine Seite mit Video und lade diese Ansicht neu." }));
      return;
    }
    try {
      root.appendChild(app.view === "debug" ? DebugView.render(app, hooks) : Builder.render(app, hooks));
    } catch (err) {
      app.errors.push("Anzeige-Fehler: " + (err && err.message ? err.message : err));
      root.appendChild(h("div", { class: "errbox", text: app.errors.join("\n") }));
    }
  }

  // ---------- Start ----------
  try {
    const params = new URLSearchParams(location.search);
    if (params.get("view") === "debug") app.view = "debug";
    if (params.get("view") === "helper") app.view = "helper";
    const saved = await store.get("model2", null);
    if (saved) {
      const keys = Object.keys(C.DEFAULT_MODEL).filter((k) => C.SESSION_KEYS.indexOf(k) < 0);
      Object.assign(app.model, C.pickKeys(saved, keys));
    }
    app.userPresets = await store.get("presets2", []);
    app.mask = await store.get("mask", true);

    if (mode === "popup") {
      const ts = await browser.tabs.query({ active: true, currentWindow: true });
      app.tabId = ts[0] ? ts[0].id : null;
    } else if (params.get("tab")) {
      app.tabId = parseInt(params.get("tab"), 10);
    } else {
      const ts = (await browser.tabs.query({})).filter((t) => /^https?:/i.test(t.url || ""));
      ts.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      app.tabId = ts[0] ? ts[0].id : null;
    }
    await refresh();
    render();
    setInterval(poll, 1500);
  } catch (err) {
    root.replaceChildren(h("div", { class: "errbox", text: "Start fehlgeschlagen: " + (err && err.message ? err.message : err) }));
  }
})();
