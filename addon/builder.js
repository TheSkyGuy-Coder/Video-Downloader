// Der Baukasten: Quelle wählen, Optionen anklicken, fertigen Befehl kopieren.
(function (root) {
  "use strict";
  const { h, chips, toggle, copyText } = root.Dom;
  const S = root.Shared;
  const C = root.Cmd;

  const card = (title, ...kids) => h("section", { class: "card" }, h("h3", { text: title }), ...kids);
  const row = (...kids) => h("div", { class: "row" }, ...kids);
  const fld = (label, el) => h("label", { class: "fld" }, h("span", { class: "fld-l", text: label }), el);

  function text(m, key, hooks, attrs) {
    return h(
      "input",
      Object.assign(
        {
          type: "text",
          value: m[key] || "",
          oninput: (ev) => {
            m[key] = ev.target.value;
            hooks.text();
          },
        },
        attrs
      )
    );
  }

  // ---------- Befehl einfärben ----------
  function tokens(cmd) {
    const out = [];
    const re = /"[^"]*"|--?[A-Za-z][\w-]*|\S+/g;
    let last = 0;
    let first = true;
    let m;
    while ((m = re.exec(cmd))) {
      if (m.index > last) out.push(cmd.slice(last, m.index));
      const tok = m[0];
      let cls = "";
      if (first) {
        cls = "t-prog";
        first = false;
      } else if (tok.charAt(0) === '"') cls = "t-str";
      else if (tok.charAt(0) === "-") cls = "t-flag";
      out.push(cls ? h("span", { class: cls, text: tok }) : tok);
      last = re.lastIndex;
    }
    if (last < cmd.length) out.push(cmd.slice(last));
    return out;
  }

  // ---------- Quelle ----------
  const JOB_LABEL = { queued: "⏳ wartet", running: "⬇ lädt", done: "✓ fertig", failed: "✗ Fehler", canceled: "abgebrochen" };
  function jobLabel(j) {
    if (j.status === "running" && j.progress != null) return "⬇ " + Math.round(j.progress) + " %";
    return JOB_LABEL[j.status] || j.status;
  }
  function jobBadge(j) {
    return j ? h("span", { class: "badge job " + j.status, title: "Auftrag im Helfer", text: jobLabel(j) }) : null;
  }

  function sourcesCard(app, hooks) {
    const box = h("div", { class: "sources" });
    if (!app.sources.length) {
      box.appendChild(
        h("p", {
          class: "empty",
          text: "Keine Quelle gefunden. Öffne eine Seite mit Video (http/https) und spiele es ab, dann hier erneut schauen.",
        })
      );
    }
    app.sources.forEach((s) => {
      const sel = s.id === app.selected;
      box.appendChild(
        h(
          "button",
          { type: "button", class: "src" + (sel ? " sel" : ""), "aria-pressed": String(sel), onclick: () => hooks.selectSource(s.id) },
          h("span", { class: "src-ico", text: s.icon }),
          h("span", { class: "src-main" }, h("span", { class: "src-title", text: s.title + (s.n && app.streamCount > 1 ? " " + s.n : "") }), h("span", { class: "src-sub", text: s.sub })),
          h("span", { class: "src-badges" }, jobBadge(app.jobFor && app.jobFor(s)), s.badge ? h("span", { class: "badge " + (s.badgeClass || ""), text: s.badge }) : null)
        )
      );
    });
    return card("Quelle", box);
  }

  function toolRow(app, hooks) {
    const m = app.model;
    const isPage = app.src.kind === "page";
    return h(
      "div",
      { class: "seg-wrap" },
      chips(
        [
          { value: "ytdlp", label: "yt-dlp", title: "Lädt Videos von Seiten und Streams, kann Formate wählen" },
          {
            value: "ffmpeg",
            label: "ffmpeg",
            disabled: isPage,
            title: isPage ? "ffmpeg braucht eine Stream-URL, bei Seiten wie YouTube nimm yt-dlp" : "Kopiert oder wandelt einen Stream direkt um",
          },
        ],
        m.tool,
        (v) => {
          m.tool = v;
          hooks.change();
        }
      )
    );
  }

  // ---------- Vorlagen ----------
  function presetsCard(app, hooks) {
    const m = app.model;
    const box = h("div", { class: "chips" });
    const chip = (name, p, onclick) =>
      h("button", { type: "button", class: "chip", "aria-pressed": String(C.matchesPreset(m, p)), text: name, onclick });
    C.PRESETS.forEach((p) => box.appendChild(chip(p.name, p.model, () => hooks.applyPreset(p.model))));
    app.userPresets.forEach((p, i) =>
      box.appendChild(
        h(
          "span",
          { class: "chipx" },
          chip(p.name, p.model, () => hooks.applyPreset(p.model)),
          h("button", { type: "button", class: "x", title: "Vorlage löschen", text: "×", onclick: () => hooks.deletePreset(i) })
        )
      )
    );
    if (app.savingPreset) {
      const inp = h("input", { type: "text", placeholder: "Name der Vorlage", maxlength: "30" });
      const save = () => hooks.savePreset(inp.value);
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") save();
        if (ev.key === "Escape") hooks.cancelSavePreset();
      };
      box.appendChild(
        h(
          "span",
          { class: "saveform" },
          inp,
          h("button", { type: "button", class: "btn small primary", text: "Speichern", onclick: save }),
          h("button", { type: "button", class: "btn small", text: "Abbrechen", onclick: () => hooks.cancelSavePreset() })
        )
      );
      setTimeout(() => inp.focus(), 0);
    } else {
      box.appendChild(h("button", { type: "button", class: "chip add", text: "＋ Aktuelle Einstellung speichern", onclick: () => hooks.startSavePreset() }));
    }
    return card("Vorlagen", box);
  }

  // ---------- gemeinsame Karten ----------
  function nameCard(app, hooks, isYtdlp) {
    const m = app.model;
    const nameInput = h("input", {
      type: "text",
      value: m.name || "",
      placeholder: isYtdlp ? "z. B. Mein Video oder %(title)s" : "z. B. Mein Video",
      oninput: (ev) => {
        m.name = ev.target.value;
        if (app.src) app.names[app.src.id] = m.name;
        hooks.text();
      },
    });
    const kids = [fld("Dateiname (ohne Endung)", nameInput)];
    if (isYtdlp) {
      const add = (label, tok) =>
        h("button", {
          type: "button",
          class: "chip small",
          text: "+ " + label,
          title: "Fügt " + tok + " in den Dateinamen ein",
          onclick: () => {
            nameInput.value = (nameInput.value ? nameInput.value + " " : "") + tok;
            nameInput.dispatchEvent(new Event("input"));
          },
        });
      kids.push(
        h("div", { class: "chips tight" }, add("Titel", "%(title)s"), add("ID", "[%(id)s]"), add("Kanal", "%(uploader)s"), add("Datum", "%(upload_date)s"))
      );
    }
    kids.push(
      fld(
        "Zielordner (leer = aktueller Ordner)",
        text(m, "folder", hooks, { placeholder: "z. B. C:\\Users\\Name\\Downloads oder ~/Downloads" })
      )
    );
    if (isYtdlp) kids.push(row(toggle("Sonderzeichen im Namen vermeiden", m.restrict, (v) => { m.restrict = v; hooks.text(); })));
    return card("Name & Ort", ...kids);
  }

  function clipCard(app, hooks, isYtdlp) {
    const m = app.model;
    const kids = [
      row(
        fld("Start", text(m, "start", hooks, { placeholder: "z. B. 1:30" })),
        fld("Ende", text(m, "end", hooks, { placeholder: "z. B. 2:45" }))
      ),
    ];
    if (isYtdlp) kids.push(row(toggle("Genau schneiden (langsamer)", m.exact, (v) => { m.exact = v; hooks.text(); }, "Neu kodieren an den Schnittpunkten")));
    else kids.push(h("p", { class: "dim small-t", text: "Leer lassen = ganzes Video. Beim Kopieren schneidet ffmpeg an Keyframes, das kann ein paar Sekunden abweichen." }));
    return card("Ausschnitt (optional)", ...kids);
  }

  function netCard(app, hooks, isYtdlp) {
    const m = app.model;
    const s = app.src;
    const items = [];
    const t = (key, label, title) => items.push(toggle(label, m[key], (v) => { m[key] = v; hooks.text(); }, title));
    if (s.referer) t("referer", "Referer", "Seite, von der das Video stammt (hilft gegen 403-Fehler)");
    if (s.ua) t("ua", "User-Agent", "Browser-Kennung der Seite mitgeben");
    if (isYtdlp && s.origin) t("origin", "Origin", "Origin-Header der Seite mitgeben");
    if (isYtdlp) t("cookies", "Cookies", "Nutzt deine Anmeldung im Browser (z. B. bei YouTube-Bot-Abfrage)");
    if (isYtdlp) t("ipv4", "Nur IPv4 (-4)", "Erzwingt IPv4. Hilft bei 403-Fehlern, wenn Browser und Download unterschiedliche IP-Adressen nutzen");
    if (!items.length) return null;
    const kids = [h("div", { class: "togs" }, items)];
    if (isYtdlp && m.cookies) {
      const sel = h(
        "select",
        { onchange: () => { m.cookieBrowser = sel.value; hooks.text(); } },
        ["firefox", "chrome", "edge", "brave", "safari"].map((b) => h("option", { value: b, selected: m.cookieBrowser === b, text: b }))
      );
      kids.push(row(fld("Cookies aus Browser", sel)));
    }
    return card("Netzwerk", ...kids);
  }

  // ---------- yt-dlp ----------
  function ytdlpCards(app, hooks) {
    const m = app.model;
    const s = app.src;
    const cards = [];
    const ch = (opts, key, cb) => chips(opts, m[key], (v) => { m[key] = v; if (cb) cb(); hooks.change(); });

    cards.push(
      card("Inhalt", ch([{ value: "av", label: "Video + Ton" }, { value: "audio", label: "Nur Ton" }, { value: "video", label: "Nur Video" }], "mode"))
    );

    if (m.mode === "audio") {
      cards.push(card("Audioformat", ch(C.AUDIO_FORMATS.map((f) => ({ value: f[0], label: f[1] })), "audioFmt")));
    } else {
      const avail = C.availHeights(s);
      const maxH = avail ? Math.max.apply(null, avail) : null;
      const qopts = [{ value: 0, label: "Beste" }].concat(
        C.HEIGHTS.map((hh) => ({
          value: hh,
          label: hh + "p",
          dim: maxH != null && hh > maxH,
          title: maxH != null && hh > maxH ? "In diesem Stream nicht vorhanden, yt-dlp nimmt die nächstbeste Stufe" : undefined,
        }))
      );
      const kids = [ch(qopts, "height")];
      if (avail) kids.push(h("p", { class: "dim small-t", text: "Im Stream gefunden: " + S.variantSummary(s.playlist) }));
      cards.push(card("Qualität", ...kids));
      const fmt = [
        h("div", { class: "fld-l", text: "Dateiformat" }),
        ch([{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }, { value: "webm", label: "WebM" }, { value: "auto", label: "Automatisch" }], "container"),
      ];
      fmt.push(
        h("div", { class: "fld-l", text: "Formatwahl" }),
        ch(
          [
            { value: "sort", label: "Standard", title: "Beste Qualität, bevorzugt kompatible Codecs" },
            { value: "strict", label: "Nur MP4/M4A", title: "Wählt nur MP4-Video und M4A-Ton (klassische Formatwahl)" },
          ],
          "fmtStyle"
        )
      );
      if (m.container === "mp4" && m.fmtStyle !== "strict")
        fmt.push(row(toggle("H.264/AAC bevorzugen (läuft auf jedem Gerät)", m.compat, (v) => { m.compat = v; hooks.text(); }, "Beschränkt die Auswahl auf besonders kompatible Codecs, bei YouTube meist bis 1080p")));
      cards.push(card("Format", ...fmt));
    }

    cards.push(nameCard(app, hooks, true));

    // Extras
    const ex = [];
    const tg = (key, label, title) => toggle(label, m[key], (v) => { m[key] = v; hooks.text(); }, title);
    const togs = [tg("meta", "Metadaten einbetten", "Titel, Kanal, Datum in die Datei schreiben"), tg("thumb", "Vorschaubild einbetten", "Cover in die Datei einbetten")];
    if (m.mode !== "audio") togs.push(tg("chapters", "Kapitel einbetten"));
    if (s.site === "youtube") togs.push(tg("sponsor", "Sponsor-Segmente entfernen", "SponsorBlock: schneidet gemeldete Werbesegmente heraus"));
    ex.push(h("div", { class: "togs" }, togs));
    if (m.mode !== "audio") {
      ex.push(h("div", { class: "fld-l", text: "Untertitel" }));
      ex.push(
        chips(
          [{ value: "none", label: "Keine" }, { value: "embed", label: "Einbetten" }, { value: "file", label: "Als Datei" }],
          m.subs,
          (v) => { m.subs = v; hooks.change(); }
        )
      );
      if (m.subs !== "none") {
        ex.push(row(fld("Sprachen (Kürzel, mit Komma)", text(m, "subLangs", hooks, { placeholder: "de,en" })), toggle("Auch automatische", m.autoSubs, (v) => { m.autoSubs = v; hooks.text(); })));
      }
    }
    const yt = s.yt;
    if (s.kind === "page" && yt && (yt.list || yt.type === "playlist" || yt.type === "channel")) {
      ex.push(h("div", { class: "fld-l", text: "Playlist" }));
      ex.push(
        chips(
          [{ value: "single", label: "Nur dieses Video", disabled: yt.type === "playlist" || yt.type === "channel" }, { value: "all", label: "Ganze Playlist" }],
          m.playlist,
          (v) => { m.playlist = v; hooks.change(); }
        )
      );
    }
    cards.push(card("Extras", ...ex));
    cards.push(clipCard(app, hooks, true));
    const net = netCard(app, hooks, true);
    if (net) cards.push(net);

    // Fortgeschritten
    const adv = h("details", { class: "card adv", open: app.advOpen ? "" : null });
    adv.ontoggle = () => { app.advOpen = adv.open; };
    adv.appendChild(h("summary", { text: "Fortgeschritten" }));
    adv.appendChild(
      row(
        fld("Tempolimit (z. B. 5M)", text(m, "rate", hooks, { placeholder: "kein Limit" })),
        fld("Parallele Teile", chips([{ value: 0, label: "Standard" }, { value: 4, label: "4" }, { value: 8, label: "8" }, { value: 16, label: "16" }], m.frags, (v) => { m.frags = v; hooks.change(); }))
      )
    );
    adv.appendChild(row(toggle("Ausführliche Ausgabe (-v)", m.verbose, (v) => { m.verbose = v; hooks.text(); })));
    adv.appendChild(row(toggle("Download nicht fortsetzen (--no-continue)", m.noContinue, (v) => { m.noContinue = v; hooks.text(); })));
    adv.appendChild(fld("Eigene Argumente", text(m, "extra", hooks, { placeholder: "z. B. --proxy http://127.0.0.1:8080" })));
    cards.push(adv);
    return cards;
  }

  // ---------- ffmpeg ----------
  function ffmpegCards(app, hooks) {
    const m = app.model;
    const s = app.src;
    const cards = [];
    const modeChips = chips(
      [
        { value: "copy", label: "Kopieren (schnell)", title: "Keine Neukodierung, keine Qualitätsverluste" },
        { value: "h264", label: "Neu kodieren (H.264)", title: "Langsamer, funktioniert aber auf jedem Gerät" },
        { value: "mp3", label: "Nur Ton (MP3)" },
        { value: "aac", label: "Nur Ton (AAC)" },
      ],
      m.ffMode,
      (v) => { m.ffMode = v; hooks.change(); }
    );
    const out = [modeChips];
    if (m.ffMode === "h264") {
      out.push(h("div", { class: "fld-l", text: "Qualität der Neukodierung" }));
      out.push(chips([{ value: 18, label: "Hoch (groß)" }, { value: 23, label: "Normal" }, { value: 28, label: "Klein" }], m.crf, (v) => { m.crf = v; hooks.change(); }));
    }
    if (m.ffMode === "copy" || m.ffMode === "h264") {
      out.push(h("div", { class: "fld-l", text: "Dateiformat" }));
      out.push(chips([{ value: "mp4", label: "MP4" }, { value: "mkv", label: "MKV" }], m.container === "mkv" ? "mkv" : "mp4", (v) => { m.container = v; hooks.change(); }));
    }
    cards.push(card("Ausgabe", ...out));

    const pl = s.playlist && s.playlist.valid && s.playlist.kind === "master" ? s.playlist : null;
    if (pl) {
      const opts = [{ value: "auto", label: "Automatisch (beste)", title: "ffmpeg wählt selbst" }].concat(
        S.sortedVariants(pl).map((v) => ({
          value: v.uri,
          label: S.variantLabel(v) + (v.bandwidth ? " · " + (v.bandwidth / 1e6).toFixed(1).replace(".", ",") + " Mbit/s" : ""),
        }))
      );
      cards.push(card("Qualität des Streams", chips(opts, m.ffVariant, (v) => { m.ffVariant = v; hooks.change(); })));
    } else {
      cards.push(
        card(
          "Qualität des Streams",
          h("p", {
            class: "dim small-t",
            text: s.playlist
              ? "Das ist keine Master-Playlist, es gibt nur eine Qualitätsstufe."
              : "Playlist-Inhalt nicht erfasst, ffmpeg wählt automatisch. Zum Auswählen die Seite neu laden und das Video neu starten.",
          })
        )
      );
    }
    cards.push(nameCard(app, hooks, false));
    cards.push(clipCard(app, hooks, false));
    const net = netCard(app, hooks, false);
    if (net) cards.push(net);
    cards.push(card("Sonstiges", row(toggle("Vorhandene Datei ohne Nachfrage überschreiben (-y)", m.ffOverwrite, (v) => { m.ffOverwrite = v; hooks.text(); }))));
    return cards;
  }

  // ---------- Befehlsfeld ----------
  function fillCommand(box, app, hooks) {
    box.replaceChildren();
    if (!app.src) {
      box.appendChild(h("p", { class: "warn", text: "Noch keine Quelle. Öffne eine Seite mit Video und spiele es ab." }));
      return;
    }
    const res = C.build(app.src, app.model);
    if (!res.ok) {
      box.appendChild(h("p", { class: "warn", text: res.reason }));
      return;
    }
    const copyBtn = h("button", { type: "button", class: "btn primary big", text: "Befehl kopieren" });
    copyBtn.onclick = () => copyText(res.text, copyBtn);
    const jobKey = C.jobUrl(app.src, app.model);
    const prev = app.jobFor(app.src);
    const active = !!(prev && (prev.status === "queued" || prev.status === "running" || prev.status === "done"));
    const armed = app.armedUrl === jobKey;
    const sendBtn = h("button", {
      type: "button", class: "btn primary big" + (active && !armed ? " warnbtn" : ""),
      text: active ? (armed ? "Wirklich nochmal senden" : "Schon im Helfer (" + jobLabel(prev).replace(/^\S+\s/, "") + "), nochmal senden?") : "An Helfer senden",
      title: "Legt einen Download-Auftrag im lokalen Helfer an",
    });
    const sm = app.sendMsg && app.sendMsg.key === jobKey && Date.now() - app.sendMsg.ts < 30000 ? app.sendMsg : null;
    const msg = h("p", { class: "sendmsg " + (sm ? (sm.ok ? "ok" : "bad") : ""), style: sm ? "" : "display:none", text: sm ? sm.text : "" });
    sendBtn.onclick = async () => {
      if (active && !armed) {
        app.armedUrl = jobKey;
        return fillCommand(box, app, hooks);
      }
      const typed = app.names[app.src.id];
      let site = "";
      try { site = new URL(app.tab.url).hostname.replace(/^www\./, ""); } catch (_) {}
      const jr = C.toJob(app.src, app.model, {
        title: app.titleFor(app.src), site, pageUrl: app.tab.url || "",
        name: typed != null && String(typed).trim() ? String(typed).trim() : null,
      });
      const show = (ok, text) => {
        app.sendMsg = { key: jobKey, ok, text, ts: Date.now() };
        msg.className = "sendmsg " + (ok ? "ok" : "bad");
        msg.textContent = text;
        msg.style.display = "";
      };
      if (!jr.ok) return show(false, jr.reason || "Kein Auftrag möglich.");
      if (active) jr.job.force = true;
      sendBtn.disabled = true;
      try {
        const r = await root.Dom.bgCall({ type: "helperSend", job: jr.job });
        app.armedUrl = null;
        if (r && r.ok) show(true, "✓ Auftrag angelegt" + (r.id ? " (" + r.id + ")" : "") + ". Fortschritt im Helfer-Dashboard.");
        else show(false, (r && r.error) || "Senden fehlgeschlagen.");
        hooks.helperRefresh();
      } finally {
        sendBtn.disabled = false;
      }
    };
    const actions = h("div", { class: "actions" }, sendBtn, copyBtn);
    if (app.model.tool === "ytdlp") {
      const fb = h("button", { type: "button", class: "btn", text: "Formate anzeigen (-F)", title: "Kopiert einen Befehl, der alle verfügbaren Formate auflistet" });
      fb.onclick = () => copyText(C.build(app.src, app.model, { list: true }).text, fb);
      actions.appendChild(fb);
    }
    box.append(h("pre", { class: "cmd" }, tokens(res.text)), actions, msg);
    res.warnings.forEach((w) => box.appendChild(h("p", { class: "warn", text: "⚠ " + w })));
    const hs = C.hints(app.src, app.model);
    if (hs.length) {
      const d = h("details", { class: "hints", open: app.hintsOpen ? "" : null }, h("summary", { text: "Tipps bei Problemen" }), h("ul", null, hs.map((t) => h("li", { text: t }))));
      d.ontoggle = () => { app.hintsOpen = d.open; };
      box.appendChild(d);
    }
  }

  function updateCommand(app, hooks) {
    const box = document.querySelector(".cmdbox");
    if (box) fillCommand(box, app, hooks);
  }

  function render(app, hooks) {
    const main = h("div", { class: "main" });
    main.appendChild(sourcesCard(app, hooks));
    if (app.src) {
      main.appendChild(toolRow(app, hooks));
      main.appendChild(presetsCard(app, hooks));
      (app.model.tool === "ffmpeg" ? ffmpegCards(app, hooks) : ytdlpCards(app, hooks)).forEach((c) => main.appendChild(c));
    }
    const box = h("div", { class: "cmdbox" });
    fillCommand(box, app, hooks);
    return h("div", { class: "layout" }, main, h("aside", { class: "side" }, box));
  }

  root.Builder = { render, updateCommand, tokens };
})(typeof self !== "undefined" ? self : this);
