// Befehls-Baukasten: aus Modell + Quelle wird ein yt-dlp- oder ffmpeg-Befehl.
(function (root) {
  "use strict";
  const S = root.Shared || require("./shared.js");

  const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
  const AUDIO_FORMATS = [
    ["mp3", "MP3"], ["m4a", "M4A"], ["opus", "Opus"], ["flac", "FLAC"], ["best", "Original"],
  ];

  const DEFAULT_MODEL = {
    tool: "ytdlp",
    // yt-dlp
    mode: "av", height: 0, container: "mp4", compat: true, audioFmt: "mp3",
    subs: "none", subLangs: "de,en", autoSubs: false,
    thumb: false, meta: true, chapters: false, sponsor: false,
    exact: false, restrict: false, rate: "", frags: 0,
    cookies: false, cookieBrowser: "firefox", verbose: false, extra: "",
    ipv4: false, noContinue: false, fmtStyle: "sort",
    // ffmpeg
    ffMode: "copy", crf: 23, ffOverwrite: true,
    // gemeinsam
    referer: true, ua: true, origin: false, folder: "",
    // nur für die aktuelle Quelle (werden nicht gespeichert)
    name: "", start: "", end: "", ffVariant: "auto", playlist: "single",
  };
  const SESSION_KEYS = ["name", "start", "end", "ffVariant", "playlist"];
  const PRESET_KEYS = [
    "tool", "mode", "height", "container", "compat", "audioFmt", "subs", "subLangs", "autoSubs",
    "thumb", "meta", "chapters", "sponsor", "ffMode", "crf", "fmtStyle",
  ];

  const pickKeys = (o, keys) => {
    const r = {};
    keys.forEach((k) => {
      if (o[k] !== undefined) r[k] = o[k];
    });
    return r;
  };
  const preset = (over) => Object.assign(pickKeys(DEFAULT_MODEL, PRESET_KEYS), over);

  const PRESETS = [
    { id: "best", name: "Beste Qualität", model: preset({}) },
    { id: "1080", name: "1080p", model: preset({ height: 1080 }) },
    { id: "720", name: "720p (klein)", model: preset({ height: 720 }) },
    { id: "classic", name: "MP4 strikt (1080p)", model: preset({ height: 1080, fmtStyle: "strict" }) },
    { id: "mp3", name: "Nur Ton (MP3)", model: preset({ mode: "audio", audioFmt: "mp3", thumb: true }) },
    { id: "subs", name: "Mit Untertiteln", model: preset({ subs: "embed", subLangs: "de,en" }) },
    { id: "ffcopy", name: "ffmpeg: kopieren", model: preset({ tool: "ffmpeg", ffMode: "copy" }) },
  ];

  function persistable(m) {
    const r = Object.assign({}, m);
    SESSION_KEYS.forEach((k) => delete r[k]);
    return r;
  }
  function matchesPreset(m, p) {
    return PRESET_KEYS.every((k) => p[k] === undefined || m[k] === p[k]);
  }

  // ---------- Hilfsfunktionen ----------
  const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, "") + '"';
  const qUrl = (u) => '"' + String(u == null ? "" : u).replace(/"/g, "%22") + '"';
  const validTime = (s) => /^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(String(s).trim());

  // Dateiname mit yt-dlp-Platzhaltern (%(title)s usw.): Platzhalter bleiben, Sonderzeichen fliegen raus
  function templateName(s) {
    const re = /(%\([^)]*\)[#0 +\-\d.]*[a-zA-Z])/;
    return String(s || "")
      .split(re)
      .map((part, i) => (i % 2 ? part : part.replace(/[\\/:*?"<>|%]/g, "")))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150);
  }
  // Dateiname ohne Platzhalter (für ffmpeg)
  function plainName(s) {
    return S.safeName(String(s || "").replace(/%\([^)]*\)[#0 +\-\d.]*[a-zA-Z]/g, " "));
  }
  function cleanFolder(s) {
    let f = String(s || "").replace(/"/g, "").trim();
    if (f.length > 1) f = f.replace(/[\\/]+$/, "");
    return f;
  }
  function joinPath(folder, file) {
    if (!folder) return file;
    const sep = /\\|^[A-Za-z]:/.test(folder) ? "\\" : "/";
    return folder + sep + file;
  }

  function availHeights(src) {
    const pl = src && src.playlist;
    if (!pl || !pl.valid || pl.kind !== "master") return null;
    const hs = [];
    pl.variants.forEach((v) => {
      const m = /(\d+)x(\d+)/.exec(v.resolution || "");
      if (m) hs.push(parseInt(m[2], 10));
    });
    return hs.length ? hs : null;
  }

  function defaultPlaylist(src) {
    const yt = src && src.yt;
    return yt && (yt.type === "playlist" || yt.type === "channel") ? "all" : "single";
  }

  function pageTarget(src, m) {
    const yt = S.parseYouTube(src.url);
    if (!yt) return src.url;
    if (yt.type === "playlist") return "https://www.youtube.com/playlist?list=" + yt.list;
    if (yt.type === "channel") return src.url;
    if (yt.id) {
      let u = "https://www.youtube.com/watch?v=" + yt.id;
      if (m.playlist === "all" && yt.list) u += "&list=" + yt.list;
      return u;
    }
    return src.url;
  }

  // ---------- yt-dlp ----------
  function buildYtdlp(src, m, opts) {
    opts = opts || {};
    const warnings = [];
    const a = ["yt-dlp"];
    const isPage = src.kind === "page";
    const yt = src.site === "youtube";

    if (m.verbose) a.push("-v");
    if (m.ipv4) a.push("-4");
    if (m.referer && src.referer) a.push("--referer " + q(src.referer));
    if (m.ua && src.ua) a.push("--user-agent " + q(src.ua));
    if (m.origin && src.origin) a.push("--add-header " + q("Origin:" + src.origin));
    if (m.cookies) a.push("--cookies-from-browser " + (m.cookieBrowser || "firefox"));

    if (!opts.list) {
      const hs = m.height ? "[height<=?" + m.height + "]" : "";
      const video = m.mode !== "audio";
      const strict = m.fmtStyle === "strict";
      if (m.mode === "audio") {
        a.push('-f "ba/b"', "-x");
        if (m.audioFmt && m.audioFmt !== "best") a.push("--audio-format " + m.audioFmt, "--audio-quality 0");
      } else if (m.mode === "video") {
        a.push(strict ? '-f "bestvideo' + hs + "[ext=mp4]/bestvideo" + hs + '"' : '-f "bv*' + hs + '"');
      } else if (strict) {
        a.push('-f "bestvideo' + hs + "[ext=mp4]+bestaudio[ext=m4a]/best" + hs + "[ext=mp4]/best" + hs + '"');
      } else {
        a.push('-f "bv*' + hs + "+ba/b" + hs + '"');
      }
      if (video && !strict && m.container === "mp4" && m.compat) a.push('-S "vcodec:h264,acodec:m4a"');
      if (m.mode === "av" && m.container && m.container !== "auto") a.push("--merge-output-format " + m.container);

      if (video && m.subs !== "none") {
        a.push("--write-subs");
        if (m.autoSubs) a.push("--write-auto-subs");
        const langs = String(m.subLangs || "").replace(/[^A-Za-z0-9,.*_-]/g, "");
        if (langs) a.push("--sub-langs " + q(langs));
        if (m.subs === "embed") a.push("--embed-subs");
      }
      if (m.thumb) {
        a.push("--embed-thumbnail");
        if (video && m.container === "webm") warnings.push("Vorschaubild einbetten klappt bei WebM nicht, nimm MP4 oder MKV.");
      }
      if (m.meta) a.push("--embed-metadata");
      if (m.chapters && video) a.push("--embed-chapters");
      if (m.sponsor && yt) a.push("--sponsorblock-remove sponsor");
      if (isPage) a.push(m.playlist === "all" ? "--yes-playlist" : "--no-playlist");

      const s = String(m.start || "").trim();
      const e = String(m.end || "").trim();
      if (s || e) {
        let bad = false;
        if (s && !validTime(s)) {
          warnings.push("Start „" + s + "“ ist keine gültige Zeit (z. B. 1:30 oder 0:01:30).");
          bad = true;
        }
        if (e && !validTime(e)) {
          warnings.push("Ende „" + e + "“ ist keine gültige Zeit (z. B. 1:30 oder 0:01:30).");
          bad = true;
        }
        if (!bad) {
          a.push("--download-sections " + q("*" + (s || "0") + "-" + (e || "inf")));
          if (m.exact) a.push("--force-keyframes-at-cuts");
        }
      }
      const rate = String(m.rate || "").trim();
      if (rate) {
        if (/^\d+(\.\d+)?[KkMmGg]?$/.test(rate)) a.push("-r " + rate);
        else warnings.push("Tempolimit „" + rate + "“ ist ungültig (z. B. 5M oder 500K).");
      }
      if (m.frags > 1) a.push("-N " + m.frags);
      if (m.restrict) a.push("--restrict-filenames");
      if (m.noContinue) a.push("--no-continue");

      if (!opts.job) {
        const folder = cleanFolder(m.folder);
        if (folder) a.push("-P " + q(folder));
        let tpl = templateName(m.name) || (isPage ? "%(title)s" : "video");
        if (!/%\(ext\)/.test(tpl)) tpl += ".%(ext)s";
        a.push("-o " + q(tpl));
      }
      const extra = String(m.extra || "").trim();
      if (extra) a.push(extra);
    }
    a.push(qUrl(isPage ? pageTarget(src, m) : src.url));
    return { ok: true, text: a.join(" "), warnings };
  }

  // ---------- ffmpeg ----------
  function buildFfmpeg(src, m, opts) {
    opts = opts || {};
    if (src.kind === "page") {
      return { ok: false, reason: "ffmpeg braucht eine direkte Stream-URL (m3u8 oder mp4). Für Seiten wie YouTube ist yt-dlp das richtige Werkzeug." };
    }
    const warnings = [];
    const a = ["ffmpeg"];
    if (m.ffOverwrite) a.push("-y");

    const pl = src.playlist && src.playlist.valid && src.playlist.kind === "master" ? src.playlist : null;
    let variant = null;
    if (pl && m.ffVariant && m.ffVariant !== "auto") variant = pl.variants.find((v) => v.uri === m.ffVariant) || null;
    const audio = variant ? S.pickAudio(variant, pl) : null;
    const useSepAudio = !!(audio && audio.uri);
    const audioOnly = m.ffMode === "mp3" || m.ffMode === "aac";

    const timeOpts = [];
    const s = String(m.start || "").trim();
    const e = String(m.end || "").trim();
    if (s) {
      if (validTime(s)) timeOpts.push("-ss " + s);
      else warnings.push("Start „" + s + "“ ist keine gültige Zeit (z. B. 1:30 oder 0:01:30).");
    }
    if (e) {
      if (validTime(e)) timeOpts.push("-to " + e);
      else warnings.push("Ende „" + e + "“ ist keine gültige Zeit (z. B. 1:30 oder 0:01:30).");
    }
    const input = (u) =>
      [].concat(
        m.ua && src.ua ? ["-user_agent " + q(src.ua)] : [],
        m.referer && src.referer ? ["-headers " + q("Referer: " + src.referer)] : [],
        timeOpts,
        ["-i " + qUrl(u)]
      ).join(" ");

    const mainUrl = variant ? variant.uri : src.url;
    if (audioOnly && useSepAudio) {
      a.push(input(audio.uri));
    } else {
      a.push(input(mainUrl));
      if (useSepAudio) a.push(input(audio.uri));
    }
    if (!audioOnly && useSepAudio) a.push("-map 0:v -map 1:a");

    let ext = m.container === "mkv" ? "mkv" : "mp4";
    if (m.ffMode === "h264") {
      a.push("-c:v libx264 -crf " + (parseInt(m.crf, 10) || 23) + " -preset veryfast -c:a aac -b:a 192k");
    } else if (m.ffMode === "mp3") {
      a.push("-vn -c:a libmp3lame -q:a 2");
      ext = "mp3";
    } else if (m.ffMode === "aac") {
      a.push("-vn -c:a aac -b:a 192k");
      ext = "m4a";
    } else {
      a.push("-c copy");
    }

    let base = plainName(m.name) || "video";
    if (variant) base += "_" + S.variantLabel(variant);
    if (opts.job) return { ok: true, text: a.join(" "), warnings, ext };
    a.push(q(joinPath(cleanFolder(m.folder), base + "." + ext)));
    return { ok: true, text: a.join(" "), warnings };
  }

  function build(src, m, opts) {
    if (!src) return { ok: false, reason: "Keine Quelle gewählt." };
    return m.tool === "ffmpeg" ? buildFfmpeg(src, m, opts) : buildYtdlp(src, m, opts);
  }

  // Zerlegt den erzeugten Befehl in Argumente (Anführungszeichen entfernt), für den Helfer
  function tokenize(text) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  // Auftrag für den Helfer: gleiche Einstellungen, aber Ausgabe/Benennung bestimmt der Helfer
  function toJob(src, m, ctx) {
    ctx = ctx || {};
    const res = build(src, m, { job: true });
    if (!res.ok) return res;
    return {
      ok: true,
      warnings: res.warnings,
      job: {
        tool: m.tool, argv: tokenize(res.text), kind: src.kind,
        url: src.kind === "page" ? pageTarget(src, m) : src.url,
        title: ctx.title || "", site: ctx.site || "", page_url: ctx.pageUrl || "",
        name: ctx.name || null, ext: res.ext || null,
      },
    };
  }

  function hints(src, m) {
    const out = [];
    if (!src) return out;
    if (m.tool === "ffmpeg") {
      out.push("403-Fehler: Referer-Option aktiv lassen. Ist der Link abgelaufen, Seite neu laden, Video starten und den Befehl neu kopieren.");
      return out;
    }
    if (src.site === "youtube") {
      out.push("yt-dlp aktuell halten: yt-dlp -U (YouTube ändert sich oft).");
      out.push(
        "Für YouTube empfiehlt yt-dlp eine JavaScript-Runtime, am besten Deno (Windows: winget install --id=DenoLand.Deno, Mac: brew install deno). Ohne sie fehlen oft Formate oder Downloads scheitern."
      );
      out.push("Meldung „Sign in to confirm you’re not a bot“: unter Netzwerk „Cookies“ aktivieren, dann nutzt yt-dlp deine Firefox-Anmeldung.");
    }
    out.push("403-Fehler: unter Netzwerk „Nur IPv4 (-4)“ und „Cookies“ einschalten, das hilft oft. Danach Seite neu laden und den Befehl frisch kopieren.");
    out.push("ffmpeg muss installiert sein, damit Video und Ton zusammengefügt werden.");
    if (src.kind === "stream") out.push("403 oder „Unsupported URL“: Seite neu laden, Video starten und den Befehl sofort ausführen, Links laufen schnell ab.");
    return out;
  }

  const api = {
    HEIGHTS, AUDIO_FORMATS, DEFAULT_MODEL, SESSION_KEYS, PRESET_KEYS, PRESETS,
    persistable, matchesPreset, pickKeys,
    templateName, plainName, cleanFolder, joinPath, validTime,
    availHeights, defaultPlaylist, pageTarget,
    buildYtdlp, buildFfmpeg, build, hints, tokenize, toJob,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Cmd = api;
})(typeof self !== "undefined" ? self : this);
