// Helfer-Ansicht: Verbindung zum lokalen Helfer einrichten, testen, Aufträge ansehen.
(function (root) {
  "use strict";
  const { h, bgCall } = root.Dom;

  const STATUS = { queued: "Wartet", running: "Läuft", done: "Fertig", failed: "Fehler", canceled: "Abgebrochen" };

  function jobList(jobs) {
    const box = h("div", { class: "hjobs" });
    if (!jobs.length) return h("p", { class: "empty", text: "Noch keine Aufträge." });
    jobs.slice(0, 8).forEach((j) => {
      const pct = j.progress != null && j.status === "running" ? " " + Math.round(j.progress) + " %" : "";
      box.appendChild(
        h("div", { class: "hjob" },
          h("span", { class: "badge " + (j.status === "done" ? "ok" : j.status === "failed" ? "bad" : ""), text: STATUS[j.status] || j.status }),
          " ", h("span", { text: (j.title || j.url || j.id) + pct }))
      );
    });
    return box;
  }

  function render(app) {
    const wrap = h("div", { class: "debug" });
    wrap.appendChild(h("h2", { text: "Helfer" }));
    wrap.appendChild(h("p", { class: "muted", text: "Der Helfer läuft lokal auf deinem Rechner (start-helper.bat). Das Add-on schickt ihm Downloads als Auftrag. Adresse und Token stehen im Helfer-Dashboard unter „Mit Add-on verbinden“." }));

    const url = h("input", { type: "text", class: "txt", placeholder: "http://127.0.0.1:8765", spellcheck: "false" });
    const token = h("input", { type: "password", class: "txt", placeholder: "Token aus dem Dashboard", autocomplete: "off", spellcheck: "false" });
    const status = h("div", { class: "hstatus" });
    const jobsBox = h("div");
    const dash = h("a", { class: "btn", href: "#", text: "Dashboard öffnen", style: "display:none" });

    let cfgUrl = "";
    async function test() {
      status.replaceChildren(h("p", { text: "Prüfe Verbindung…" }));
      const r = await bgCall({ type: "helperPing" });
      if (!r || !r.ok) {
        dash.style.display = "none";
        jobsBox.replaceChildren();
        status.replaceChildren(h("p", { class: "warn", text: "✗ " + ((r && r.error) || "Keine Antwort.") }));
        return;
      }
      const tools = r.tools || {};
      const ver = (t) => (tools[t] && (tools[t].version || (tools[t].found ? "ok" : null))) || "fehlt";
      status.replaceChildren(
        h("p", { class: "ok", text: "✓ Verbunden · yt-dlp: " + ver("ytdlp") + " · ffmpeg: " + ver("ffmpeg") + ((r.settings && r.settings.base_dir) ? " · Ordner: " + r.settings.base_dir : "") })
      );
      dash.href = cfgUrl;
      dash.style.display = "";
      const st = await bgCall({ type: "helperState" });
      jobsBox.replaceChildren(h("h3", { text: "Letzte Aufträge" }), jobList((st && st.jobs) || []));
    }

    const save = h("button", { type: "button", class: "btn primary", text: "Speichern und testen" });
    save.onclick = async () => {
      const r = await bgCall({ type: "helperSave", url: url.value, token: token.value });
      if (!r || !r.ok) {
        status.replaceChildren(h("p", { class: "warn", text: "✗ " + ((r && r.error) || "Speichern fehlgeschlagen.") }));
        return;
      }
      cfgUrl = url.value.trim() || "http://127.0.0.1:8765";
      await test();
    };
    dash.onclick = (ev) => {
      ev.preventDefault();
      browser.tabs.create({ url: dash.href });
    };

    wrap.append(
      h("label", { class: "hvfld" }, h("span", { text: "Adresse" }), url),
      h("label", { class: "hvfld" }, h("span", { text: "Token" }), token),
      h("div", { class: "actions" }, save, dash),
      status,
      jobsBox
    );

    bgCall({ type: "helperGet" }).then((c) => {
      c = c || {};
      cfgUrl = c.url || "http://127.0.0.1:8765";
      url.value = cfgUrl;
      token.value = c.token || "";
      if (c.token) test();
      else status.replaceChildren(h("p", { class: "warn", text: "Noch nicht eingerichtet." }));
    });
    return wrap;
  }

  root.HelperView = { render };
})(typeof self !== "undefined" ? self : this);
