// Gemeinsame Hilfsfunktionen (Hintergrundskript, Popup, Debug-Seite, Tests).
(function (root) {
  "use strict";

  const VERSION = "2.0";

  // ---------- Erkennung ----------
  const isManifestUrl = (u) => /\.(m3u8|mpd)(\?|#|$)/i.test(u);
  const isDirectMediaUrl = (u) => /\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(u);
  const isSegmentUrl = (u) => /\.(ts|m4s|aac|m4a|cmfv|cmfa)(\?|#|$)/i.test(u);
  const isManifestContentType = (ct) => /mpegurl|dash\+xml/i.test(ct || "");

  // ---------- Namen / Formatierung ----------
  function safeName(s) {
    return (s || "video").replace(/[\\/:*?"<>|%]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "video";
  }

  function dq(s) {
    return String(s == null ? "" : s).replace(/"/g, "%22");
  }

  function fmtBytes(n) {
    if (n == null) return "?";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
  }

  function shortUrl(u) {
    try {
      const x = new URL(u);
      const parts = x.pathname.split("/").filter(Boolean);
      const last = parts.length ? parts[parts.length - 1] : "";
      return x.host + (parts.length > 1 ? "/…/" : "/") + last;
    } catch (_) {
      return String(u).slice(0, 60);
    }
  }

  // ---------- URLs unkenntlich machen (für Berichte) ----------
  function maskSeg(seg) {
    if (seg.length > 16 && /^[A-Za-z0-9+=_%.-]+$/.test(seg) && !/\.(m3u8|mpd|ts|m4s|mp4|aac|vtt)$/i.test(seg)) {
      return seg.slice(0, 4) + "…(" + seg.length + ")";
    }
    return seg;
  }
  const maskPath = (p) => p.split("/").map(maskSeg).join("/");
  function maskQuery(q) {
    q = String(q || "").replace(/^\?/, "");
    if (!q) return "";
    return "?" + q.split("&").map((kv) => kv.split("=")[0] + "=…").join("&");
  }
  function maskUrl(u) {
    u = String(u == null ? "" : u);
    try {
      const x = new URL(u);
      return x.origin + maskPath(x.pathname) + maskQuery(x.search);
    } catch (_) {
      const i = u.indexOf("?");
      return maskPath(i < 0 ? u : u.slice(0, i)) + (i < 0 ? "" : maskQuery(u.slice(i)));
    }
  }
  function maskPlaylistText(text) {
    return String(text)
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim();
        if (!t) return t;
        if (t.charAt(0) !== "#") return maskUrl(t);
        return t.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + maskUrl(u) + '"');
      })
      .join("\n");
  }

  // ---------- Header ----------
  function headersToObject(list) {
    const o = {};
    (list || []).forEach((hd) => {
      const k = String(hd.name).toLowerCase();
      let v = hd.value != null ? String(hd.value) : "";
      if (k === "cookie") v = "<" + v.split(";").length + " Cookie(s), " + v.length + " Zeichen>";
      else if (k === "authorization" || k === "proxy-authorization") v = "<entfernt>";
      o[k] = o[k] ? o[k] + ", " + v : v;
    });
    return o;
  }

  const RES_KEEP = [
    "content-type", "content-length", "content-encoding", "content-disposition", "cache-control", "server",
    "access-control-allow-origin", "location", "www-authenticate", "via", "x-cache", "cf-cache-status", "age", "accept-ranges",
  ];
  function pickResponseHeaders(list) {
    const o = {};
    let sc = 0;
    (list || []).forEach((hd) => {
      const k = String(hd.name).toLowerCase();
      if (k === "set-cookie") sc++;
      else if (RES_KEEP.indexOf(k) >= 0) o[k] = String(hd.value == null ? "" : hd.value);
    });
    if (sc) o["set-cookie"] = "<" + sc + " Cookie(s) gesetzt>";
    return o;
  }

  // ---------- Playlist-Analyse ----------
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }
  const num = (x) => (x == null || x === "" ? null : parseInt(x, 10));
  function resolveUri(uri, base) {
    try {
      return new URL(uri, base).href;
    } catch (_) {
      return uri;
    }
  }

  function parsePlaylist(text, baseUrl) {
    const out = {
      valid: false, kind: null, version: null, targetDuration: null, endlist: false,
      segments: 0, duration: 0, variants: [], audio: [], subtitles: [], keys: [], drm: false,
    };
    if (typeof text !== "string") return out;
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    out.valid = (lines[0] || "").trim().indexOf("#EXTM3U") === 0;
    if (!out.valid) return out;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.charAt(0) !== "#") continue;
      if (l.indexOf("#EXT-X-STREAM-INF:") === 0) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().charAt(0) === "#")) j++;
        const uri = j < lines.length ? lines[j].trim() : "";
        out.variants.push({
          bandwidth: num(a.BANDWIDTH), resolution: a.RESOLUTION || null, codecs: a.CODECS || null,
          audio: a.AUDIO || null, subtitles: a.SUBTITLES || null, frameRate: a["FRAME-RATE"] || null,
          uri: uri ? resolveUri(uri, baseUrl) : null,
        });
      } else if (l.indexOf("#EXT-X-MEDIA:") === 0) {
        const a = parseAttrs(l.slice(13));
        const item = {
          type: a.TYPE || null, group: a["GROUP-ID"] || null, name: a.NAME || null, lang: a.LANGUAGE || null,
          default: a.DEFAULT === "YES", uri: a.URI ? resolveUri(a.URI, baseUrl) : null,
        };
        if (item.type === "AUDIO") out.audio.push(item);
        else if (item.type === "SUBTITLES" || item.type === "CLOSED-CAPTIONS") out.subtitles.push(item);
      } else if (l.indexOf("#EXT-X-KEY:") === 0 || l.indexOf("#EXT-X-SESSION-KEY:") === 0) {
        const a = parseAttrs(l.slice(l.indexOf(":") + 1));
        if (a.METHOD && a.METHOD !== "NONE") out.keys.push({ method: a.METHOD, keyformat: a.KEYFORMAT || null, uri: a.URI || null });
      } else if (l.indexOf("#EXTINF:") === 0) {
        out.segments++;
        out.duration += parseFloat(l.slice(8)) || 0;
      } else if (l.indexOf("#EXT-X-TARGETDURATION:") === 0) {
        out.targetDuration = num(l.slice(22));
      } else if (l.indexOf("#EXT-X-VERSION:") === 0) {
        out.version = num(l.slice(15));
      } else if (l.indexOf("#EXT-X-ENDLIST") === 0) {
        out.endlist = true;
      }
    }
    out.kind = out.variants.length ? "master" : out.segments ? "media" : "unbekannt";
    out.drm = out.keys.some((k) => /^SAMPLE-AES/i.test(k.method || "") || (k.keyformat && !/^identity$/i.test(k.keyformat)));
    return out;
  }

  const heightOf = (v) => {
    const m = /(\d+)x(\d+)/.exec((v && v.resolution) || "");
    return m ? parseInt(m[2], 10) : 0;
  };
  function sortedVariants(p) {
    return (p && p.variants ? p.variants.slice() : []).sort((a, b) => heightOf(b) - heightOf(a) || (b.bandwidth || 0) - (a.bandwidth || 0));
  }
  function variantLabel(v) {
    const hgt = heightOf(v);
    if (hgt) return hgt + "p";
    if (v && v.bandwidth) return Math.round(v.bandwidth / 1000) + "k";
    return "var";
  }
  function variantSummary(p) {
    const seen = [];
    sortedVariants(p).forEach((v) => {
      const l = variantLabel(v);
      if (seen.indexOf(l) < 0) seen.push(l);
    });
    return seen.join(", ");
  }
  function pickAudio(variant, p) {
    if (!variant || !variant.audio || !p) return null;
    const c = p.audio.filter((a) => a.group === variant.audio && a.uri);
    if (!c.length) return null;
    return c.find((a) => a.default) || c[0];
  }

  function describePlaylist(p, mu) {
    mu = mu || ((x) => x);
    if (!p) return ["(Inhalt nicht erfasst)"];
    if (!p.valid) return ["KEINE gültige m3u8-Playlist (beginnt nicht mit #EXTM3U)"];
    const out = [];
    if (p.kind === "master") {
      out.push("Master-Playlist mit " + p.variants.length + " Variante(n):");
      sortedVariants(p).forEach((v) => {
        out.push(
          "  " + (v.resolution || "?") + " · " + (v.bandwidth ? Math.round(v.bandwidth / 1000) + " kbit/s" : "?") +
            (v.codecs ? " · " + v.codecs : "") + (v.audio ? " · Audio-Gruppe " + v.audio : " · Ton im Video") + "\n    " + mu(v.uri || "")
        );
      });
    } else if (p.kind === "media") {
      out.push(
        "Medien-Playlist: " + p.segments + " Segmente, ca. " + fmtDur(p.duration) +
          (p.endlist ? "" : " (kein ENDLIST: Livestream oder unvollständig)")
      );
    } else {
      out.push("Playlist ohne erkennbare Varianten oder Segmente");
    }
    p.audio.forEach((a) =>
      out.push("Audio: " + [a.name, a.lang, a.group].filter(Boolean).join(" / ") + (a.uri ? " · eigene Playlist " + mu(a.uri) : " · im Video enthalten"))
    );
    p.subtitles.forEach((a) => out.push("Untertitel: " + [a.name, a.lang].filter(Boolean).join(" / ") + (a.uri ? " · " + mu(a.uri) : "")));
    if (!p.keys.length) out.push("Verschlüsselung: keine erkennbar");
    p.keys.forEach((k) =>
      out.push(
        "Verschlüsselung: " + k.method + (k.keyformat ? " (" + k.keyformat + ")" : "") +
          (/^SAMPLE-AES/i.test(k.method) || (k.keyformat && !/^identity$/i.test(k.keyformat))
            ? " → DRM-Hinweis: lässt sich so nicht herunterladen"
            : " → normale HLS-Verschlüsselung, yt-dlp/ffmpeg können das")
      )
    );
    return out;
  }

  // ---------- YouTube ----------
  const YT_ID = /^[\w-]{6,}$/;
  function ytHost(x) {
    return x.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  }
  function parseYouTube(url) {
    let x;
    try {
      x = new URL(url);
    } catch (_) {
      return null;
    }
    const host = ytHost(x);
    const list = x.searchParams.get("list");
    if (host === "youtu.be") {
      const id = x.pathname.split("/").filter(Boolean)[0];
      return id && YT_ID.test(id) ? { site: "youtube", type: "video", id, list } : null;
    }
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    const p = x.pathname;
    if (p === "/watch") {
      const id = x.searchParams.get("v");
      if (id && YT_ID.test(id)) return { site: "youtube", type: "video", id, list };
      return list ? { site: "youtube", type: "playlist", id: null, list } : null;
    }
    const m = /^\/(shorts|live|embed|v)\/([\w-]{6,})/.exec(p);
    if (m && m[2] !== "videoseries") return { site: "youtube", type: m[1] === "shorts" ? "shorts" : "video", id: m[2], list };
    if (p === "/playlist" && list) return { site: "youtube", type: "playlist", id: null, list };
    if (/^\/(@[^/]+|channel\/|c\/|user\/)/.test(p)) return { site: "youtube", type: "channel", id: null, list: null };
    return null;
  }
  function youtubeEmbedWatchUrl(url) {
    let x;
    try {
      x = new URL(url);
    } catch (_) {
      return null;
    }
    const host = ytHost(x);
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    const m = /^\/embed\/([\w-]{6,})/.exec(x.pathname);
    return m && m[1] !== "videoseries" ? "https://www.youtube.com/watch?v=" + m[1] : null;
  }
  function cleanTitle(t) {
    return String(t || "").replace(/^\(\d+\)\s*/, "").replace(/\s+[-\u2013|]\s+YouTube$/i, "").trim();
  }

  // ---------- Anzeige-Helfer ----------
  const statusText = (e) => (e.via === "youtube-embed" ? "▶" : e.status != null ? String(e.status) : e.error ? "ERR" : "…");
  function statusClass(e) {
    if (e.error || (e.status != null && e.status >= 400)) return "bad";
    if (e.status != null && e.status >= 200 && e.status < 300) return "ok";
    return "";
  }
  function metaText(e) {
    const p = [];
    if (e.contentType) p.push(String(e.contentType).split(";")[0]);
    if (e.error) p.push("Fehler: " + e.error);
    const pl = e.playlist;
    if (pl) {
      if (!pl.valid) p.push("⚠ keine gültige m3u8");
      else if (pl.kind === "master") p.push("Master · " + pl.variants.length + " Varianten (" + variantSummary(pl) + ")");
      else if (pl.kind === "media") p.push("Medien-Playlist · " + pl.segments + " Segmente");
      if (pl.drm) p.push("⚠ DRM-Hinweis");
    }
    if (e.via === "direct") p.push("direkte Videodatei");
    if (e.via === "youtube-embed") p.push("YouTube-Einbettung");
    return p.join(" · ");
  }

  // ---------- Bericht ----------
  function buildReport(state, o) {
    const mask = !(o && o.mask === false);
    const mu = (u) => (u ? (mask ? maskUrl(u) : u) : "");
    const L = [];
    const entries = state.entries || [];
    L.push("m3u8-grabber Debug-Bericht (v" + VERSION + ")");
    L.push("Zeit: " + new Date().toISOString());
    if (state.ua) L.push("Browser: " + state.ua);
    L.push("Seite: " + (mu(state.pageUrl) || "?"));
    L.push("Einträge: " + entries.length + " · Segment-Requests gezählt: " + ((state.counts && state.counts.segments) || 0));
    L.push("Antwortinhalt mitlesen: " + (state.capture ? "an" : "aus"));
    L.push("URLs maskiert: " + (mask ? "ja" : "nein"));
    entries.forEach((e, i) => {
      L.push("");
      L.push("=== Eintrag " + (i + 1) + " ===");
      L.push("URL: " + mu(e.url));
      L.push("Erkannt über: " + e.via + " · Methode: " + (e.method || "?") + " · Typ: " + (e.type || "?") + " · Treffer: " + e.hits);
      L.push("Status: " + statusText(e) + (e.statusLine ? " (" + e.statusLine + ")" : "") + (e.error ? " · Fehler: " + e.error : ""));
      L.push(
        "Content-Type: " + (e.contentType || "?") + " · Content-Length: " + (e.contentLength || "?") +
          " · gelesen: " + (e.bodyBytes != null ? e.bodyBytes + " B" : "?")
      );
      if (e.fromCache != null || e.ip) L.push("Cache: " + e.fromCache + " · IP: " + (e.ip || "?"));
      if (e.documentUrl) L.push("Dokument-URL: " + mu(e.documentUrl));
      if (e.originUrl) L.push("Origin-URL: " + mu(e.originUrl));
      (e.redirects || []).forEach((r) => L.push("Redirect: " + String(r).replace(/https?:\/\/\S+/, (m) => mu(m))));
      L.push("Request-Header:");
      const rk = Object.keys(e.reqHeaders || {});
      if (!rk.length) L.push("  (nicht erfasst)");
      rk.forEach((k) => L.push("  " + k + ": " + (k === "referer" || k === "origin" ? mu(e.reqHeaders[k]) : e.reqHeaders[k])));
      L.push("Response-Header:");
      const sk = Object.keys(e.resHeaders || {});
      if (!sk.length) L.push("  (nicht erfasst)");
      sk.forEach((k) => L.push("  " + k + ": " + (k === "location" ? mu(e.resHeaders[k]) : e.resHeaders[k])));
      L.push("Playlist-Analyse:");
      describePlaylist(e.playlist, mu).forEach((l) => L.push("  " + l));
      if (e.bodyHead != null) {
        L.push("Antwortanfang:");
        let txt;
        if (e.playlist && e.playlist.valid) {
          txt = (mask ? maskPlaylistText(e.bodyHead) : e.bodyHead).split("\n").slice(0, 25).join("\n");
        } else {
          txt = String(e.bodyHead).replace(/\s+/g, " ").slice(0, 300);
          if (mask) txt = txt.replace(/https?:\/\/[^\s"'<>]+/g, (m) => maskUrl(m));
        }
        txt.split("\n").forEach((l) => L.push("  | " + l));
      } else {
        L.push("Antwortinhalt: nicht erfasst");
      }
      if (e.bodyNote) L.push("Hinweis: " + e.bodyNote);
      if (e.refetch) {
        const r = e.refetch;
        L.push(
          "Nachladen-Test (ohne Seiten-Referer): " +
            (r.error ? "Fehler " + r.error : r.status + " · " + (r.contentType || "?") + " · " + r.bytes + " B · Anfang: " + JSON.stringify(r.head || ""))
        );
      }
    });
    if (state.log && state.log.length) {
      L.push("");
      L.push("=== Protokoll (letzte Einträge) ===");
      state.log.slice(-40).forEach((l) => L.push(new Date(l.t).toISOString().slice(11, 19) + " [" + l.level + "] " + l.msg));
    }
    return L.join("\n");
  }

  const api = {
    VERSION,
    isManifestUrl, isDirectMediaUrl, isSegmentUrl, isManifestContentType,
    safeName, dq, fmtBytes, fmtDur, shortUrl,
    maskUrl, maskPlaylistText, headersToObject, pickResponseHeaders,
    parsePlaylist, sortedVariants, variantLabel, variantSummary, pickAudio, describePlaylist,
    parseYouTube, youtubeEmbedWatchUrl, cleanTitle,
    statusText, statusClass, metaText, buildReport,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Shared = api;
})(typeof self !== "undefined" ? self : this);
