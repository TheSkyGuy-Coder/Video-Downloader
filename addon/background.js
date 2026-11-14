"use strict";
/* global Shared, browser */

const MAX_BODY = 1536 * 1024;
const tabs = new Map(); // tabId -> { pageUrl, entries[], counts{}, started, last }
const byRequest = new Map(); // requestId -> entry
const logBuf = [];
const settings = { capture: true };

function addLog(level, msg) {
  logBuf.push({ t: Date.now(), level, msg: String(msg) });
  if (logBuf.length > 200) logBuf.shift();
  (level === "error" ? console.error : console.log)("[m3u8-grabber]", msg);
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("error", (ev) => addLog("error", "Skriptfehler: " + ev.message + " (" + ev.filename + ":" + ev.lineno + ")"));
  self.addEventListener("unhandledrejection", (ev) =>
    addLog("error", "Promise-Fehler: " + ((ev.reason && ev.reason.message) || ev.reason))
  );
}

function safe(name, fn) {
  try {
    fn();
  } catch (err) {
    addLog("error", name + ": " + (err && err.message ? err.message : err));
  }
}

function newTab(pageUrl) {
  return { pageUrl: pageUrl || "", entries: [], counts: { segments: 0 }, started: Date.now(), last: Date.now() };
}

function getTab(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = newTab("");
    tabs.set(tabId, t);
  }
  return t;
}

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  const n = t ? t.entries.length : 0;
  try {
    browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#d33" }).catch(() => {});
  } catch (_) {}
}

function headerValue(list, name) {
  const hd = (list || []).find((x) => String(x.name).toLowerCase() === name);
  return hd ? String(hd.value == null ? "" : hd.value) : null;
}

function addEmbedEntry(tabId, url, via) {
  const t = getTab(tabId);
  let e = t.entries.find((x) => x.url === url);
  if (e) {
    e.hits++;
    return e;
  }
  e = {
    url, time: Date.now(), via, hits: 1, method: null, type: "sub_frame", frameId: null,
    documentUrl: t.pageUrl || null, originUrl: null, status: null, statusLine: null, contentType: null, contentLength: null,
    fromCache: null, ip: null, completed: true, error: null, redirects: [], reqHeaders: null, resHeaders: null,
    bodyHead: null, bodyBytes: null, bodyNote: "Eingebettetes Video, kein Stream-Request", capturing: false, playlist: null, refetch: null,
  };
  t.entries.push(e);
  t.last = Date.now();
  addLog("info", "YouTube-Einbettung erkannt: " + url);
  updateBadge(tabId);
  return e;
}

function ensureEntry(d, via) {
  let e = byRequest.get(d.requestId);
  if (e) return e;
  const t = getTab(d.tabId);
  e = t.entries.find((x) => x.url === d.url);
  if (e) {
    e.hits++;
    e.redirects = [];
  } else {
    e = {
      url: d.url, time: Date.now(), via, hits: 1,
      method: d.method || null, type: d.type || null, frameId: d.frameId,
      documentUrl: d.documentUrl || null, originUrl: d.originUrl || null,
      status: null, statusLine: null, contentType: null, contentLength: null,
      fromCache: null, ip: null, completed: false, error: null, redirects: [],
      reqHeaders: null, resHeaders: null,
      bodyHead: null, bodyBytes: null, bodyNote: null, capturing: false, playlist: null, refetch: null,
    };
    t.entries.push(e);
    t.last = Date.now();
    addLog("info", "Neuer Eintrag (" + via + "): " + Shared.maskUrl(d.url));
    updateBadge(d.tabId);
  }
  byRequest.set(d.requestId, e);
  return e;
}

// ---------- Antwortinhalt mitlesen (Firefox: StreamFilter) ----------
function startCapture(d, e) {
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(d.requestId);
  } catch (err) {
    e.bodyNote = "Stream-Filter nicht möglich: " + (err && err.message ? err.message : err);
    addLog("warn", e.bodyNote);
    return;
  }
  e.capturing = true;
  const chunks = [];
  let size = 0;
  let total = 0;
  filter.ondata = (ev) => {
    try {
      total += ev.data.byteLength;
      if (size < MAX_BODY) {
        const part = new Uint8Array(ev.data.slice(0, MAX_BODY - size));
        chunks.push(part);
        size += part.byteLength;
      }
    } catch (err) {
      addLog("error", "ondata: " + err.message);
    }
    filter.write(ev.data); // Daten immer unverändert weiterreichen
  };
  filter.onstop = () => {
    try {
      filter.disconnect();
    } catch (_) {}
    e.capturing = false;
    try {
      finishCapture(e, chunks, size, total);
    } catch (err) {
      addLog("error", "finishCapture: " + err.message);
    }
  };
  filter.onerror = () => {
    e.capturing = false;
    e.bodyNote = "Stream-Filter-Fehler: " + filter.error;
    addLog("warn", e.bodyNote);
    try {
      filter.disconnect();
    } catch (_) {}
  };
}

function finishCapture(e, chunks, size, total) {
  const bytes = new Uint8Array(size);
  let off = 0;
  chunks.forEach((c) => {
    bytes.set(c, off);
    off += c.length;
  });
  e.bodyBytes = total;
  if (size === 0) {
    e.bodyHead = "";
    e.bodyNote = "Leere Antwort";
    return;
  }
  if (size >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    e.bodyHead = "";
    e.bodyNote = "Antwort ist gzip-komprimiert und wurde nicht dekodiert";
    return;
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  e.bodyHead = text.slice(0, 4000);
  const isDash = /\.mpd(\?|#|$)/i.test(e.url) || /dash\+xml/i.test(e.contentType || "");
  if (isDash) {
    e.playlist = null;
    e.bodyNote = "DASH-Manifest (MPD), keine Detailanalyse";
  } else {
    e.playlist = Shared.parsePlaylist(text, e.url);
    if (size < total) e.bodyNote = "Antwort größer als " + MAX_BODY + " Bytes, Analyse unvollständig";
  }
}

// ---------- Nachladen als Test ----------
async function refetch(tabId, url) {
  const t = tabs.get(tabId);
  const e = t && t.entries.find((x) => x.url === url);
  if (!e) throw new Error("Eintrag nicht gefunden");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const r = { at: Date.now() };
  try {
    const resp = await fetch(url, { credentials: "include", cache: "no-store", signal: ctrl.signal });
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(new Uint8Array(buf.slice(0, MAX_BODY)));
    r.status = resp.status;
    r.statusText = resp.statusText;
    r.contentType = resp.headers.get("content-type");
    r.bytes = buf.byteLength;
    r.head = text.slice(0, 300);
    if (e.bodyHead == null && resp.status === 200) {
      e.bodyHead = text.slice(0, 4000);
      e.bodyBytes = buf.byteLength;
      e.playlist = Shared.parsePlaylist(text, url);
      e.bodyNote = "Inhalt per Nachladen geholt (ohne Seiten-Referer)";
    }
  } catch (err) {
    r.error = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  e.refetch = r;
  return r;
}

function snapshot(tabId) {
  const t = tabs.get(tabId) || newTab("");
  return {
    version: Shared.VERSION,
    tabId,
    pageUrl: t.pageUrl,
    counts: t.counts,
    entries: t.entries,
    log: logBuf.slice(-80),
    capture: settings.capture,
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
  };
}

function openDebug(tabId) {
  return browser.tabs.create({ url: browser.runtime.getURL("app.html?view=debug") + (tabId != null ? "&tab=" + tabId : "") });
}

// ---------- Verbindung zum lokalen Helfer ----------
const HELPER_DEFAULT = "http://127.0.0.1:8765";
const HELPER_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/;

async function helperCfg() {
  try {
    const r = await browser.storage.local.get("helper");
    return Object.assign({ url: HELPER_DEFAULT, token: "" }, r && r.helper);
  } catch (_) {
    return { url: HELPER_DEFAULT, token: "" };
  }
}

async function helperFetch(path, body) {
  const cfg = await helperCfg();
  if (!cfg.token) return { ok: false, error: "Noch kein Token eingetragen. Im Reiter „Helfer“ Adresse und Token eintragen." };
  if (!HELPER_URL_RE.test(cfg.url)) return { ok: false, error: "Die Adresse muss http://127.0.0.1:PORT oder http://localhost:PORT sein." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(cfg.url.replace(/\/+$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || (data && data.ok === false)) {
      const why = res.status === 401 ? "Das Token ist falsch." : (data && data.error) || "HTTP " + res.status;
      return { ok: false, status: res.status, error: why };
    }
    return data || { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "Zeitüberschreitung beim Helfer." : "Helfer nicht erreichbar. Läuft er (start-helper.bat)?" };
  } finally {
    clearTimeout(timer);
  }
}

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case "get":
      return snapshot(msg.tabId);
    case "all":
      return Array.from(tabs, ([tabId, t]) => ({ tabId, pageUrl: t.pageUrl, count: t.entries.length, last: t.last }));
    case "clear":
      tabs.set(msg.tabId, newTab(getTab(msg.tabId).pageUrl));
      updateBadge(msg.tabId);
      return true;
    case "setCapture":
      settings.capture = !!msg.value;
      try {
        await browser.storage.local.set({ capture: settings.capture });
      } catch (_) {}
      return settings.capture;
    case "refetch":
      return refetch(msg.tabId, msg.url);
    case "helperGet":
      return helperCfg();
    case "helperSave": {
      const url = String(msg.url || "").trim() || HELPER_DEFAULT;
      if (!HELPER_URL_RE.test(url)) return { ok: false, error: "Die Adresse muss http://127.0.0.1:PORT oder http://localhost:PORT sein." };
      await browser.storage.local.set({ helper: { url: url.replace(/\/+$/, ""), token: String(msg.token || "").trim() } });
      return { ok: true };
    }
    case "helperPing":
      return helperFetch("/api/ping");
    case "helperState":
      return helperFetch("/api/state");
    case "helperSend":
      return helperFetch("/api/jobs", msg.job);
    case "openDebug":
      await openDebug(msg.tabId);
      return true;
    default:
      return null;
  }
}

// ---------- Listener ----------
safe("navigation", () => {
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0) return;
      tabs.set(d.tabId, newTab(d.url));
      updateBadge(d.tabId);
    },
    { urls: ["<all_urls>"], types: ["main_frame"] }
  );
});

safe("observe", () => {
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0 || d.type === "main_frame" || d.method === "OPTIONS") return;
      if (Shared.isManifestUrl(d.url)) ensureEntry(d, "url");
      else if (Shared.isDirectMediaUrl(d.url)) ensureEntry(d, "direct");
      else if (Shared.isSegmentUrl(d.url)) getTab(d.tabId).counts.segments++;
    },
    { urls: ["<all_urls>"] }
  );
});

safe("embeds", () => {
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0) return;
      const u = Shared.youtubeEmbedWatchUrl(d.url);
      if (u) addEmbedEntry(d.tabId, u, "youtube-embed");
    },
    { urls: ["*://*.youtube.com/embed/*", "*://*.youtube-nocookie.com/embed/*"], types: ["sub_frame"] }
  );
});

safe("capture", () => {
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      try {
        if (d.tabId >= 0 && d.method !== "OPTIONS" && d.type !== "main_frame") {
          const e = ensureEntry(d, "url");
          if (settings.capture && e.bodyHead == null && !e.capturing) startCapture(d, e);
        }
      } catch (err) {
        addLog("error", "capture: " + (err && err.message ? err.message : err));
      }
      return {};
    },
    { urls: ["*://*/*.m3u8*", "*://*/*.mpd*"] },
    ["blocking"]
  );
});

safe("sendHeaders", () => {
  browser.webRequest.onSendHeaders.addListener(
    (d) => {
      const e = byRequest.get(d.requestId);
      if (e) e.reqHeaders = Shared.headersToObject(d.requestHeaders);
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );
});

safe("headersReceived", () => {
  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      let e = byRequest.get(d.requestId);
      const ct = headerValue(d.responseHeaders, "content-type");
      if (!e && d.tabId >= 0 && d.method !== "OPTIONS" && Shared.isManifestContentType(ct)) e = ensureEntry(d, "content-type");
      if (!e) return;
      e.status = d.statusCode;
      e.statusLine = d.statusLine || null;
      e.contentType = ct;
      e.contentLength = headerValue(d.responseHeaders, "content-length");
      e.resHeaders = Shared.pickResponseHeaders(d.responseHeaders);
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
});

safe("redirect", () => {
  browser.webRequest.onBeforeRedirect.addListener(
    (d) => {
      const e = byRequest.get(d.requestId);
      if (e) e.redirects.push(d.statusCode + " → " + d.redirectUrl);
    },
    { urls: ["<all_urls>"] }
  );
});

safe("completed", () => {
  browser.webRequest.onCompleted.addListener(
    (d) => {
      const e = byRequest.get(d.requestId);
      if (!e) return;
      e.completed = true;
      e.status = d.statusCode;
      e.fromCache = d.fromCache;
      e.ip = d.ip || null;
      byRequest.delete(d.requestId);
    },
    { urls: ["<all_urls>"] }
  );
  browser.webRequest.onErrorOccurred.addListener(
    (d) => {
      const e = byRequest.get(d.requestId);
      if (!e) return;
      e.error = d.error;
      addLog("warn", "Request-Fehler " + d.error + ": " + Shared.maskUrl(e.url));
      byRequest.delete(d.requestId);
    },
    { urls: ["<all_urls>"] }
  );
});

safe("tabs", () => browser.tabs.onRemoved.addListener((id) => tabs.delete(id)));
safe("messages", () => browser.runtime.onMessage.addListener((msg) => handleMessage(msg)));

safe("menu", () => {
  if (!browser.menus) return;
  browser.menus.create({ id: "open-debug", title: "Debug-Seite öffnen", contexts: ["browser_action"] }, () => void browser.runtime.lastError);
  browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "open-debug") openDebug(tab && tab.id);
  });
});

safe("settings", () => {
  browser.storage.local
    .get("capture")
    .then((r) => {
      if (r && typeof r.capture === "boolean") settings.capture = r.capture;
    })
    .catch(() => {});
});

addLog("info", "Hintergrundskript gestartet (v" + Shared.VERSION + ")");
