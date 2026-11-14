// Debug-Ansicht: Streams im Detail, Bericht, Protokoll.
(function (root) {
  "use strict";
  const { h, copyText, toggle } = root.Dom;
  const S = root.Shared;
  const openSet = new Set();

  function kv(rows) {
    const t = h("table", { class: "kv" });
    rows.forEach((r) => {
      if (r[1] == null || r[1] === "") return;
      t.appendChild(h("tr", null, h("td", { text: r[0] }), h("td", { text: String(r[1]) })));
    });
    return t;
  }
  const section = (title, node) => h("section", { class: "sub" }, h("h3", { text: title }), node);
  const badge = (e) => h("span", { class: "badge " + S.statusClass(e), text: S.statusText(e) });

  function entry(e, app, hooks) {
    const pl = e.playlist;
    const d = h("details", { class: "entry", "data-id": e.url });
    d.open = openSet.has(e.url);
    d.ontoggle = () => (d.open ? openSet.add(e.url) : openSet.delete(e.url));
    d.appendChild(h("summary", null, badge(e), " ", S.metaText(e), e.hits > 1 ? " · " + e.hits + "×" : "", h("div", { class: "url", text: e.url })));

    const btns = h("div", { class: "btns" });
    btns.appendChild(h("button", { type: "button", class: "btn small primary", text: "Im Baukasten verwenden", onclick: () => hooks.useInBuilder(e.url) }));
    const cu = h("button", { type: "button", class: "btn small", text: "URL kopieren" });
    cu.onclick = () => copyText(e.url, cu);
    btns.appendChild(cu);
    if (e.via !== "youtube-embed") {
      const rf = h("button", { type: "button", class: "btn small", text: "Playlist nachladen (Test)", title: "Holt die URL erneut ohne Seiten-Referer, nur zum Vergleich" });
      rf.onclick = async () => {
        rf.disabled = true;
        try {
          await hooks.refetch(e.url);
        } finally {
          rf.disabled = false;
        }
      };
      btns.appendChild(rf);
    }
    d.appendChild(btns);

    d.appendChild(
      section(
        "Anfrage",
        kv([
          ["Methode", e.method], ["Typ", e.type], ["Erkannt über", e.via], ["Treffer", e.hits], ["Frame", e.frameId],
          ["Dokument-URL", e.documentUrl], ["Origin-URL", e.originUrl], ["Redirects", (e.redirects || []).join("\n")], ["Fehler", e.error],
        ])
      )
    );
    const rk = Object.keys(e.reqHeaders || {});
    d.appendChild(section("Request-Header", rk.length ? kv(rk.map((k) => [k, e.reqHeaders[k]])) : h("p", { class: "dim", text: "(nicht erfasst)" })));
    const sk = Object.keys(e.resHeaders || {});
    d.appendChild(
      section(
        "Antwort",
        kv(
          [
            ["Status", e.statusLine || S.statusText(e)],
            ["Cache", e.fromCache == null ? null : e.fromCache ? "ja" : "nein"],
            ["IP", e.ip],
            ["gelesene Bytes", e.bodyBytes == null ? null : S.fmtBytes(e.bodyBytes)],
          ].concat(sk.map((k) => [k, e.resHeaders[k]]))
        )
      )
    );
    d.appendChild(section("Playlist-Analyse", h("ul", null, S.describePlaylist(pl).map((l) => h("li", { text: l })))));
    if (e.bodyNote) d.appendChild(h("p", { class: "dim", text: "Hinweis: " + e.bodyNote }));
    d.appendChild(section("Antwortanfang", h("pre", { class: "plain", text: e.bodyHead != null ? e.bodyHead || "(leer)" : "(nicht erfasst)" })));
    if (e.refetch) {
      const r = e.refetch;
      d.appendChild(
        section(
          "Nachladen-Test",
          kv([["Ergebnis", r.error ? "Fehler: " + r.error : r.status + " " + (r.statusText || "")], ["Content-Type", r.contentType], ["Bytes", r.bytes], ["Anfang", r.head]])
        )
      );
    }
    return d;
  }

  function render(app, hooks) {
    const wrap = h("div", { class: "debug" });
    const bar = h("div", { class: "bar" });
    const rep = h("button", { type: "button", class: "btn primary", text: "Debug-Bericht kopieren" });
    rep.onclick = () => copyText(S.buildReport(app.snap, { mask: app.mask }), rep);
    bar.append(
      rep,
      toggle("URLs und Tokens im Bericht unkenntlich machen", app.mask, (v) => hooks.setMask(v)),
      toggle("Playlist-Inhalt mitlesen", app.snap.capture, (v) => hooks.setCapture(v), "Liest die Antwort von m3u8-Dateien mit, damit sie hier analysiert werden kann. Gilt für neu geladene Playlists."),
      h("button", { type: "button", class: "btn", text: "Liste leeren", onclick: () => hooks.clear() })
    );
    wrap.appendChild(bar);

    const list = h("div", { class: "entries" });
    const entries = (app.snap.entries || []).slice().reverse();
    if (!entries.length) {
      list.appendChild(h("p", { class: "empty", text: "Noch nichts gefunden. Video auf der Seite abspielen. Nach dem Neuladen der Erweiterung die Seite neu laden und das Video neu starten." }));
    }
    entries.forEach((e) => list.appendChild(entry(e, app, hooks)));
    wrap.appendChild(list);

    wrap.appendChild(h("h2", { text: "Protokoll" }));
    wrap.appendChild(
      h("pre", { class: "plain", text: (app.snap.log || []).map((l) => new Date(l.t).toISOString().slice(11, 19) + " [" + l.level + "] " + l.msg).join("\n") })
    );
    return wrap;
  }

  root.DebugView = { render };
})(typeof self !== "undefined" ? self : this);
