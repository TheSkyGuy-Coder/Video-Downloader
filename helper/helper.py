#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
m3u8-Helfer: lokaler Download-Server fuer das Firefox-Add-on.

Nimmt Jobs vom Add-on entgegen, laedt mit yt-dlp oder ffmpeg herunter, benennt nach Vorlagen
und komprimiert auf Knopfdruck. Nur Python-Standardbibliothek (3.9 oder neuer).
Der Server lauscht ausschliesslich auf 127.0.0.1 und verlangt ein Token.
"""
import argparse
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "2.1"
IS_WIN = os.name == "nt"
DEFAULT_PORT = 8765
APP_DIR = Path(getattr(sys, "_MEIPASS", None) or Path(__file__).resolve().parent)


# ----------------------------------------------------------------------------------------------
# Pfade, Log, JSON
# ----------------------------------------------------------------------------------------------
def default_home():
    env = os.environ.get("M3U8_HELPER_HOME")
    if env:
        return Path(env)
    if IS_WIN:
        return Path(os.environ.get("APPDATA") or Path.home()) / "m3u8-helper"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "m3u8-helper"
    return Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "m3u8-helper"


HOME = default_home()
CONFIG_FILE = HOME / "config.json"
SETTINGS_FILE = HOME / "settings.json"
JOBS_FILE = HOME / "jobs.json"
TMP_DIR = HOME / "tmp"

_log_lock = threading.Lock()


def log(msg):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    with _log_lock:
        try:
            if sys.stdout:
                print(line, flush=True)
        except Exception:
            pass
        try:
            HOME.mkdir(parents=True, exist_ok=True)
            p = HOME / "helper.log"
            if p.exists() and p.stat().st_size > 512 * 1024:
                p.replace(HOME / "helper.log.1")
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        log("Konnte %s nicht lesen: %s" % (path, e))
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ----------------------------------------------------------------------------------------------
# Einstellungen
# ----------------------------------------------------------------------------------------------
DEFAULT_PRESETS = [
    {"name": "Klein (H.264, CRF 28)", "type": "crf", "codec": "libx264", "crf": 28, "speed": "medium", "audio_kbps": 128, "max_height": 0},
    {"name": "Normal (H.264, CRF 23)", "type": "crf", "codec": "libx264", "crf": 23, "speed": "medium", "audio_kbps": 160, "max_height": 0},
    {"name": "Sehr klein (H.265, CRF 28)", "type": "crf", "codec": "libx265", "crf": 28, "speed": "medium", "audio_kbps": 96, "max_height": 0},
    {"name": "720p klein (H.264, CRF 26)", "type": "crf", "codec": "libx264", "crf": 26, "speed": "medium", "audio_kbps": 128, "max_height": 720},
    {"name": "Zielgröße in MB (H.264)", "type": "size", "codec": "libx264", "crf": 23, "speed": "medium", "audio_kbps": 128, "max_height": 0},
]


def default_settings():
    return {
        "base_dir": str(Path.home() / "Downloads" / "m3u8-helper"),
        "folder_template": "{site}",
        "name_template_page": "%(title)s [%(id)s]",
        "name_template_stream": "{page_title}",
        "compress_suffix": "_komprimiert",
        "max_downloads": 2,
        "max_compress": 1,
        "keep_jobs": 200,
        "verify_downloads": True,
        "ytdlp_path": "",
        "ffmpeg_path": "",
        "presets": json.loads(json.dumps(DEFAULT_PRESETS)),
    }


SPEEDS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]
SETTINGS = default_settings()
_settings_lock = threading.RLock()


def get_settings():
    with _settings_lock:
        return json.loads(json.dumps(SETTINGS))


def clean_settings(data, current):
    """Prueft Einstellungen aus dem Dashboard. Gibt (neu, fehler) zurueck."""
    errs = []
    new = json.loads(json.dumps(current))

    def text(key, maxlen=300, allow_empty=True):
        if key not in data:
            return
        v = data[key]
        if not isinstance(v, str):
            errs.append("%s: Text erwartet" % key)
            return
        v = v.strip()
        if len(v) > maxlen:
            errs.append("%s: zu lang" % key)
        elif not v and not allow_empty:
            errs.append("%s: darf nicht leer sein" % key)
        else:
            new[key] = v

    def integer(key, lo, hi):
        if key not in data:
            return
        try:
            v = int(data[key])
        except Exception:
            errs.append("%s: Zahl erwartet" % key)
            return
        if not lo <= v <= hi:
            errs.append("%s: erlaubt sind %d bis %d" % (key, lo, hi))
        else:
            new[key] = v

    text("base_dir", 500, allow_empty=False)
    text("folder_template", 200)
    text("name_template_page", 200, allow_empty=False)
    text("name_template_stream", 200, allow_empty=False)
    text("compress_suffix", 40)
    text("ytdlp_path", 500)
    text("ffmpeg_path", 500)
    integer("max_downloads", 1, 8)
    integer("max_compress", 1, 4)
    integer("keep_jobs", 20, 2000)
    if "verify_downloads" in data:
        if isinstance(data["verify_downloads"], bool):
            new["verify_downloads"] = data["verify_downloads"]
        else:
            errs.append("verify_downloads: Ja/Nein erwartet")

    for key in ("ytdlp_path", "ffmpeg_path"):
        v = new.get(key, "")
        if v and not Path(v).is_file():
            errs.append("%s: Datei nicht gefunden: %s" % (key, v))

    if "base_dir" in data and not errs:
        p = Path(os.path.expanduser(new["base_dir"]))
        if not p.is_absolute():
            errs.append("base_dir: bitte einen vollständigen Pfad angeben")
        else:
            try:
                p.mkdir(parents=True, exist_ok=True)
                new["base_dir"] = str(p)
            except Exception as e:
                errs.append("base_dir: Ordner kann nicht angelegt werden (%s)" % e)

    if "presets" in data:
        pr = data["presets"]
        out = []
        if not isinstance(pr, list) or not (1 <= len(pr) <= 20):
            errs.append("presets: 1 bis 20 Einträge erwartet")
        else:
            names = set()
            for i, p in enumerate(pr):
                try:
                    name = str(p["name"]).strip()[:60]
                    typ = p.get("type", "crf")
                    codec = p.get("codec", "libx264")
                    if not name or name in names:
                        raise ValueError("Name fehlt oder doppelt")
                    if typ not in ("crf", "size"):
                        raise ValueError("Typ unbekannt")
                    if codec not in ("libx264", "libx265"):
                        raise ValueError("Codec unbekannt")
                    if typ == "size":
                        codec = "libx264"
                    crf = int(p.get("crf", 23))
                    speed = p.get("speed", "medium")
                    abr = int(p.get("audio_kbps", 128))
                    mh = int(p.get("max_height", 0))
                    if not 0 <= crf <= 51 or speed not in SPEEDS or not 32 <= abr <= 320 or not 0 <= mh <= 4320:
                        raise ValueError("Wert außerhalb des erlaubten Bereichs")
                    names.add(name)
                    out.append({"name": name, "type": typ, "codec": codec, "crf": crf, "speed": speed, "audio_kbps": abr, "max_height": mh})
                except Exception as e:
                    errs.append("Preset %d: %s" % (i + 1, e))
            if not errs:
                new["presets"] = out
    return new, errs


def load_settings():
    global SETTINGS
    saved = load_json(SETTINGS_FILE, {})
    merged = default_settings()
    if isinstance(saved, dict):
        new, errs = clean_settings(saved, merged)
        if errs:
            log("Einstellungen teilweise ungültig, Standardwerte werden genutzt: %s" % "; ".join(errs))
            # nur gültige Felder übernehmen
            for k, v in saved.items():
                if k in merged and k != "presets":
                    one, e1 = clean_settings({k: v}, merged)
                    if not e1:
                        merged = one
        else:
            merged = new
    with _settings_lock:
        SETTINGS = merged


# ----------------------------------------------------------------------------------------------
# Werkzeuge finden
# ----------------------------------------------------------------------------------------------
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200


FROZEN = bool(getattr(sys, "frozen", False))
BIN_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent


def local_tool(name):
    """Sucht ein Programm im Ordner 'tools' neben der App (oder neben der .exe)."""
    for d in (BIN_DIR / "tools", BIN_DIR):
        for n in (name + (".exe" if IS_WIN else ""), name):
            p = d / n
            if p.is_file():
                return str(p)
    return None


def find_ytdlp():
    p = get_settings().get("ytdlp_path")
    if p:
        return [p]
    w = local_tool("yt-dlp") or shutil.which("yt-dlp")
    if w:
        return [w]
    if FROZEN:
        return None  # sys.executable waere die App selbst
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        return None


def find_ffmpeg(name="ffmpeg"):
    st = get_settings()
    p = st.get("ffmpeg_path")
    if p:
        if name == "ffmpeg":
            return p
        sibling = Path(p).with_name(name + (".exe" if IS_WIN else ""))
        if sibling.is_file():
            return str(sibling)
    return local_tool(name) or shutil.which(name)


def _run_quiet(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=CREATE_NO_WINDOW if IS_WIN else 0)
        return (r.stdout or r.stderr or "").strip()
    except Exception:
        return ""


_tools_cache = {"t": 0, "val": None}


def tools_info(force=False):
    if not force and _tools_cache["val"] and time.time() - _tools_cache["t"] < 30:
        return _tools_cache["val"]
    yt = find_ytdlp()
    ff = find_ffmpeg("ffmpeg")
    fp = find_ffmpeg("ffprobe")
    info = {
        "ytdlp": {"found": bool(yt), "path": " ".join(yt) if yt else "", "version": _run_quiet(yt + ["--version"]).splitlines()[0] if yt and _run_quiet(yt + ["--version"]) else ""},
        "ffmpeg": {"found": bool(ff), "path": ff or "", "version": (_run_quiet([ff, "-version"]).splitlines() or [""])[0] if ff else ""},
        "ffprobe": {"found": bool(fp), "path": fp or ""},
    }
    _tools_cache["t"] = time.time()
    _tools_cache["val"] = info
    return info


def popen(cmd):
    kw = {}
    if IS_WIN:
        kw["creationflags"] = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", bufsize=1, env=env, **kw)


def kill_tree(proc):
    if proc is None or proc.poll() is not None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=10)
        else:
            os.killpg(proc.pid, signal.SIGTERM)

            def hard():
                time.sleep(3)
                if proc.poll() is None:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except Exception:
                        pass

            threading.Thread(target=hard, daemon=True).start()
    except Exception as e:
        log("Prozess beenden fehlgeschlagen: %s" % e)
        try:
            proc.kill()
        except Exception:
            pass


# ----------------------------------------------------------------------------------------------
# Namen
# ----------------------------------------------------------------------------------------------
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {"COM%d" % i for i in range(1, 10)} | {"LPT%d" % i for i in range(1, 10)}
PLACEHOLDER = re.compile(r"(%\([^)]*\)[#0 +\-\d.]*[a-zA-Z])")


def sanitize_seg(s, maxlen=150):
    """Macht einen Namensteil dateisystemtauglich, yt-dlp-Platzhalter %(...)s bleiben erhalten."""
    parts = PLACEHOLDER.split(str(s or ""))
    out = []
    for i, part in enumerate(parts):
        if i % 2:
            out.append(part)
        else:
            out.append(re.sub(r'[<>:"/\\|?*%\x00-\x1f]', "", part))
    s = re.sub(r"\s+", " ", "".join(out)).strip(" .")
    if s.split(".")[0].upper() in RESERVED:
        s = "_" + s
    return s[:maxlen].rstrip(" .")


def strip_placeholders(s):
    return re.sub(r"\s+", " ", PLACEHOLDER.sub(" ", s)).strip(" .")


def clean_value(v):
    return sanitize_seg(strip_placeholders(str(v or "")), 120)


def job_vars(j):
    now = datetime.fromtimestamp(j.get("created") or time.time())
    title = clean_value(j.get("title")) or "video"
    return {
        "site": clean_value(j.get("site")) or "unbekannt",
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H-%M"),
        "page_title": title,
        "title": title,
        "job": j.get("id", ""),
        "kind": j.get("kind", ""),
    }


def fill_vars(tpl, vars_):
    return re.sub(r"\{(\w+)\}", lambda m: str(vars_.get(m.group(1), "")), tpl)


def resolve_names(j, st):
    """Gibt (Ordner relativ zum Basisordner mit /, Dateiname ohne Endung) zurueck."""
    v = job_vars(j)
    folder = []
    for seg in fill_vars(st["folder_template"], v).replace("\\", "/").split("/"):
        seg = sanitize_seg(seg)
        if seg and seg not in (".", ".."):
            folder.append(seg)
    tpl = j.get("name_override") or st["name_template_page" if j.get("kind") == "page" else "name_template_stream"]
    name = sanitize_seg(fill_vars(str(tpl).replace("\\", " ").replace("/", " "), v))
    return "/".join(folder), name or "video"


def unique_path(p):
    if not p.exists():
        return p
    for i in range(2, 1000):
        q = p.with_name("%s (%d)%s" % (p.stem, i, p.suffix))
        if not q.exists():
            return q
    return p.with_name("%s (%s)%s" % (p.stem, uuid.uuid4().hex[:6], p.suffix))


def fmt_speed(bps):
    if not bps or bps <= 0:
        return ""
    for unit in ("B/s", "KB/s", "MB/s", "GB/s"):
        if bps < 1024 or unit == "GB/s":
            return ("%.1f %s" if unit != "B/s" else "%.0f %s") % (bps, unit)
        bps /= 1024.0


def fmt_eta(sec):
    if sec is None or sec < 0:
        return ""
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return ("%d:%02d:%02d" % (h, m, s)) if h else ("%02d:%02d" % (m, s))


def parse_time(s):
    try:
        parts = [float(x) for x in str(s).split(":")]
    except Exception:
        return None
    t = 0.0
    for p in parts:
        t = t * 60 + p
    return t


HINTS = [
    (lambda t: "403" in t and "forbidden" in t, "Der Server lehnt ab (403). Im Add-on „Cookies“ und „Nur IPv4 (-4)“ einschalten, Seite neu laden, Video starten und den Job neu senden. Links laufen schnell ab."),
    (lambda t: "sign in to confirm" in t or "not a bot" in t, "YouTube verlangt eine Anmeldung. Im Add-on unter Netzwerk „Cookies“ einschalten."),
    (lambda t: "unsupported url" in t, "yt-dlp erkennt diese URL nicht. Seite neu laden, Video starten und den Job neu senden."),
    (lambda t: "requested format is not available" in t, "Das gewählte Format gibt es nicht. Im Add-on Qualität „Beste“ oder Formatwahl „Standard“ nehmen."),
    (lambda t: "javascript runtime" in t or "n challenge" in t, "YouTube braucht eine JavaScript-Runtime. Installiere Deno: winget install --id=DenoLand.Deno"),
    (lambda t: "ffmpeg" in t and ("not found" in t or "not installed" in t or "no such file" in t), "ffmpeg fehlt oder wird nicht gefunden. Installiere es mit: winget install ffmpeg"),
    (lambda t: "cookies" in t and ("could not" in t or "failed" in t or "database" in t), "Cookies konnten nicht gelesen werden. Bei Chrome oder Edge den Browser schließen, bei Firefox das Profil prüfen."),
]


def hint_for(text):
    t = (text or "").lower()
    for test, msg in HINTS:
        if test(t):
            return msg
    return ""


# ----------------------------------------------------------------------------------------------
# Pruefung der Jobs (Whitelist)
# ----------------------------------------------------------------------------------------------
URL_RE = re.compile(r'^https?://[^\s"<>]{1,4000}$')
BROWSERS = {"firefox", "chrome", "edge", "brave", "safari", "chromium", "opera", "vivaldi"}


def _chk_text(v):
    return len(v) <= 400 and not re.search(r"[\x00-\x1f]", v)


CHECKS = {
    "url": lambda v: bool(URL_RE.match(v)),
    "text": _chk_text,
    "header": lambda v: bool(re.match(r"^(Origin|Referer):\s?https?://\S+$", v)) and len(v) < 1000,
    "browser": lambda v: v in BROWSERS,
    "format": lambda v: bool(re.match(r"^[\w\[\]<>=!*+/,.:()&|^$~?-]{1,300}$", v)),
    "container": lambda v: v in {"mp4", "mkv", "webm"},
    "audioformat": lambda v: v in {"mp3", "m4a", "opus", "flac", "best", "aac", "wav", "vorbis"},
    "int": lambda v: bool(re.match(r"^\d{1,3}$", v)),
    "langs": lambda v: bool(re.match(r"^[A-Za-z0-9,.*_-]{1,100}$", v)),
    "sbcats": lambda v: bool(re.match(r"^[a-z,_-]{1,100}$", v)),
    "section": lambda v: bool(re.match(r"^\*[0-9:.]+-([0-9:.]+|inf)$", v)),
    "rate": lambda v: bool(re.match(r"^\d+(\.\d+)?[KkMmGg]?$", v)),
    "proxy": lambda v: bool(re.match(r"^(https?|socks5h?|socks4a?)://\S+$", v)),
    "time": lambda v: bool(re.match(r"^\d+(:\d{1,2}){0,2}(\.\d+)?$", v)),
    "ffheaders": lambda v: bool(re.match(r"^(Referer|Origin): https?://\S+$", v)),
    "mapspec": lambda v: bool(re.match(r"^\d{1,2}:[va]$", v)),
    "copy": lambda v: v == "copy",
    "vcodec": lambda v: v in {"libx264", "libx265", "copy"},
    "acodec": lambda v: v in {"aac", "copy", "libmp3lame"},
    "x264preset": lambda v: v in SPEEDS,
    "abitrate": lambda v: bool(re.match(r"^\d{2,3}k$", v)),
}

YT_RULES = {
    "-v": None, "-4": None, "--no-continue": None, "--restrict-filenames": None, "--yes-playlist": None, "--no-playlist": None,
    "-x": None, "--write-subs": None, "--write-auto-subs": None, "--embed-subs": None, "--embed-thumbnail": None,
    "--embed-metadata": None, "--embed-chapters": None, "--force-keyframes-at-cuts": None,
    "--referer": "url", "--user-agent": "text", "--add-header": "header", "--cookies-from-browser": "browser",
    "-f": "format", "-S": "format", "--merge-output-format": "container", "--audio-format": "audioformat",
    "--audio-quality": "int", "--sub-langs": "langs", "--sponsorblock-remove": "sbcats", "--download-sections": "section",
    "-r": "rate", "-N": "int", "--proxy": "proxy", "--retries": "int", "--fragment-retries": "int",
}

FF_RULES = {
    "-y": None, "-vn": None,
    "-user_agent": "text", "-headers": "ffheaders", "-ss": "time", "-to": "time", "-i": "url", "-map": "mapspec",
    "-c": "copy", "-c:v": "vcodec", "-c:a": "acodec", "-crf": "int", "-preset": "x264preset", "-b:a": "abitrate", "-q:a": "int",
}


def validate_argv(tool, argv):
    """Gibt (argumente, fehler) zurueck. Es sind nur Argumente erlaubt, die das Add-on selbst erzeugt."""
    if not isinstance(argv, list) or not argv or len(argv) > 80 or not all(isinstance(a, str) and len(a) <= 4100 for a in argv):
        return None, "argv ungültig"
    prog = "yt-dlp" if tool == "ytdlp" else "ffmpeg"
    if argv[0] != prog:
        return None, "argv muss mit %s beginnen" % prog
    rules = YT_RULES if tool == "ytdlp" else FF_RULES
    toks = argv[1:]
    out = [prog]
    i = 0
    positional = None
    inputs = 0
    while i < len(toks):
        t = toks[i]
        if t.startswith("-"):
            if t not in rules:
                return None, "Nicht erlaubtes Argument: %s" % t[:60]
            out.append(t)
            rule = rules[t]
            if rule:
                i += 1
                if i >= len(toks):
                    return None, "Wert fehlt für %s" % t
                v = toks[i]
                if not CHECKS[rule](v):
                    return None, "Ungültiger Wert für %s: %s" % (t, v[:60])
                out.append(v)
                if t == "-i":
                    inputs += 1
        else:
            if tool != "ytdlp":
                return None, "Unerwartetes Argument: %s" % t[:60]
            if positional is not None:
                return None, "Es ist nur eine URL erlaubt"
            if not URL_RE.match(t):
                return None, "Ungültige URL"
            positional = t
            out.append(t)
        i += 1
    if tool == "ytdlp":
        if positional is None or out[-1] != positional:
            return None, "Die URL muss am Ende stehen"
    elif inputs < 1:
        return None, "ffmpeg braucht mindestens ein -i"
    return out, None


def validate_payload(p):
    if not isinstance(p, dict):
        return None, "JSON-Objekt erwartet"
    tool = p.get("tool")
    if tool not in ("ytdlp", "ffmpeg"):
        return None, "tool muss ytdlp oder ffmpeg sein"
    argv, err = validate_argv(tool, p.get("argv"))
    if err:
        return None, err
    kind = p.get("kind") if p.get("kind") in ("page", "stream") else "stream"
    url = str(p.get("url") or "")
    if not URL_RE.match(url):
        return None, "url ungültig"
    site = str(p.get("site") or "")
    if not re.match(r"^[A-Za-z0-9.-]{1,100}$", site):
        site = ""
    title = re.sub(r"[\x00-\x1f]", " ", str(p.get("title") or ""))[:300].strip()
    page_url = str(p.get("page_url") or "")
    if page_url and not URL_RE.match(page_url):
        page_url = ""
    name = p.get("name")
    name = re.sub(r"[\x00-\x1f]", " ", str(name))[:200].strip() if name else None
    ext = p.get("ext")
    if tool == "ffmpeg":
        if ext not in ("mp4", "mkv", "mp3", "m4a"):
            return None, "ext muss mp4, mkv, mp3 oder m4a sein"
    else:
        ext = None
    return {"tool": tool, "argv": argv, "kind": kind, "url": url, "site": site, "title": title, "page_url": page_url, "name_override": name or None, "ext": ext}, None


# ----------------------------------------------------------------------------------------------
# Job-Verwaltung
# ----------------------------------------------------------------------------------------------
PROG_TEMPLATE = "download:[PROG] %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(progress.status)s"
PUBLIC_FIELDS = ["id", "type", "status", "created", "started", "finished", "title", "site", "url", "kind", "tool", "progress", "speed", "eta", "phase", "size", "files", "dir", "error", "hint", "parent", "preset", "last_line", "delete_original"]


def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except Exception:
        return None


class Manager:
    def __init__(self):
        self.lock = threading.RLock()
        self.jobs = {}
        self.rt = {}
        self.stop = False
        self.dirty = False
        self.load()

    # ---- Speicher
    def load(self):
        for j in load_json(JOBS_FILE, []):
            if not isinstance(j, dict) or "id" not in j:
                continue
            if j.get("status") == "running":
                j["status"] = "failed"
                j["error"] = "Der Helfer wurde beendet, bevor der Job fertig war."
                j["finished"] = time.time()
            j["log"] = j.get("log") or []
            self.jobs[j["id"]] = j

    def save(self):
        with self.lock:
            data = [dict(j) for j in self.jobs.values()]
        try:
            save_json(JOBS_FILE, data)
        except Exception as e:
            log("Jobs speichern fehlgeschlagen: %s" % e)

    def mark_dirty(self):
        self.dirty = True

    # ---- Anlegen
    def new_job(self, typ, **kw):
        j = {
            "id": uuid.uuid4().hex[:8], "type": typ, "status": "queued", "created": time.time(), "started": None, "finished": None,
            "title": "", "site": "", "url": "", "page_url": "", "kind": "stream", "tool": "ytdlp", "argv": [], "name_override": None,
            "ext": None, "progress": None, "speed": "", "eta": "", "phase": "", "size": None, "files": [], "dir": None,
            "error": "", "hint": "", "log": [], "parent": None, "preset": None, "delete_original": False, "target_mb": None,
            "input": None, "last_line": "",
        }
        j.update(kw)
        with self.lock:
            self.jobs[j["id"]] = j
        self.save()
        return j

    def add_download(self, fields):
        return self.new_job("download", **fields)

    @staticmethod
    def _url_key(u):
        return str(u or "").strip().split("#")[0]

    def find_duplicate(self, url):
        """Gibt (id, status) eines Downloads mit gleicher URL zurueck, der wartet, laeuft oder fertig ist."""
        key = self._url_key(url)
        with self.lock:
            for j in reversed(list(self.jobs.values())):
                if j.get("type") == "download" and j.get("status") in ("queued", "running", "done") and self._url_key(j.get("url")) == key:
                    return j["id"], j["status"]
        return None

    def rename(self, jid, newname):
        """Benennt die fertige Datei eines Jobs um und zieht alle Verweise nach. Gibt (neuer Pfad, Fehler) zurueck."""
        with self.lock:
            j = self.jobs.get(jid)
            if not j or j.get("status") != "done":
                return None, "Nur fertige Jobs lassen sich umbenennen"
            files = list(j.get("files") or [])
            if not files:
                return None, "Keine Datei vorhanden"
            if len(files) > 1:
                return None, "Der Job hat mehrere Dateien, Umbenennen geht nur bei einer"
            src = Path(files[0])
            if not src.is_file():
                return None, "Die Datei existiert nicht mehr"
            name = str(newname or "").replace("%", "").strip()
            if name.lower().endswith(src.suffix.lower()) and src.suffix:
                name = name[: -len(src.suffix)]
            name = sanitize_seg(name, 180)
            if not name:
                return None, "Bitte einen Namen angeben"
            target = src.with_name(name + src.suffix)
            if str(target) == str(src):
                return str(src), None
            for o in self.jobs.values():
                if o is not j and o.get("input") == str(src) and o.get("status") in ("queued", "running"):
                    return None, "Für diese Datei läuft oder wartet gerade eine Komprimierung"
            if target.exists():
                try:
                    same = os.path.samefile(str(src), str(target))
                except OSError:
                    same = False
                if not same:
                    return None, "Es gibt schon eine Datei mit diesem Namen"
            try:
                os.replace(str(src), str(target))
            except OSError as e:
                return None, "Umbenennen nicht möglich (%s). Ist die Datei gerade geöffnet?" % (e.strerror or e)
            old, new = str(src), str(target)
            for o in self.jobs.values():
                if o.get("files"):
                    o["files"] = [new if f == old else f for f in o["files"]]
                if o.get("input") == old:
                    o["input"] = new
            self.add_log(j, "Umbenannt: %s -> %s" % (src.name, target.name))
        self.save()
        return str(target), None

    def public(self, j):
        d = {k: j.get(k) for k in PUBLIC_FIELDS}
        d["files"] = list(j.get("files") or [])
        return d

    def snapshot(self):
        with self.lock:
            return [self.public(j) for j in reversed(list(self.jobs.values()))]

    # ---- Steuerung
    def cancel(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return False
            if j["status"] == "queued":
                j["status"] = "canceled"
                j["finished"] = time.time()
            elif j["status"] == "running":
                r = self.rt.get(jid)
                if r:
                    r["cancel"] = True
                    kill_tree(r.get("proc"))
        self.save()
        return True

    def retry(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j or j["status"] not in ("failed", "canceled"):
                return False
            j.update({"status": "queued", "error": "", "hint": "", "progress": None, "speed": "", "eta": "", "phase": "", "started": None, "finished": None, "last_line": "", "log": []})
        self.save()
        return True

    def remove(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                return False
            if j["status"] == "running":
                r = self.rt.get(jid)
                if r:
                    r["cancel"] = True
                    kill_tree(r.get("proc"))
            self.jobs.pop(jid, None)
        self.save()
        return True

    def clear_finished(self):
        with self.lock:
            for jid in [k for k, j in self.jobs.items() if j["status"] in ("done", "failed", "canceled")]:
                self.jobs.pop(jid, None)
        self.save()

    def trim(self):
        keep = get_settings()["keep_jobs"]
        with self.lock:
            fin = [k for k, j in self.jobs.items() if j["status"] in ("done", "failed", "canceled")]
            extra = len(self.jobs) - keep
            for k in fin[: max(0, extra)]:
                self.jobs.pop(k, None)

    def add_compress(self, jid, preset_name, target_mb, delete_original):
        st = get_settings()
        preset = next((p for p in st["presets"] if p["name"] == preset_name), None)
        if not preset:
            return None, "Preset nicht gefunden"
        with self.lock:
            src = self.jobs.get(jid)
            if not src or src["status"] != "done":
                return None, "Der Download ist noch nicht fertig"
            files = [f for f in (src.get("files") or []) if Path(f).is_file()]
        if not files:
            return None, "Keine Datei gefunden"
        if preset["type"] == "size":
            try:
                target_mb = float(target_mb)
            except Exception:
                return None, "Zielgröße in MB angeben"
            if not 1 <= target_mb <= 100000:
                return None, "Zielgröße muss zwischen 1 und 100000 MB liegen"
        else:
            target_mb = None
        created = []
        for f in files:
            j = self.new_job("compress", title=Path(f).name, site=src.get("site", ""), parent=jid, preset=preset_name, input=f, target_mb=target_mb, delete_original=bool(delete_original), tool="ffmpeg")
            created.append(j["id"])
        return created, None

    # ---- Scheduler
    def start(self):
        threading.Thread(target=self.scheduler, daemon=True).start()

    def scheduler(self):
        last_save = time.time()
        while not self.stop:
            try:
                st = get_settings()
                limits = {"download": st["max_downloads"], "compress": st["max_compress"]}
                with self.lock:
                    running = {"download": 0, "compress": 0}
                    for j in self.jobs.values():
                        if j["status"] == "running":
                            running[j["type"]] += 1
                    for j in list(self.jobs.values()):
                        if j["status"] == "queued" and running[j["type"]] < limits[j["type"]]:
                            j["status"] = "running"
                            j["started"] = time.time()
                            j["phase"] = "Startet…"
                            running[j["type"]] += 1
                            self.rt[j["id"]] = {"proc": None, "cancel": False}
                            threading.Thread(target=self.run, args=(j,), daemon=True).start()
                if self.dirty and time.time() - last_save > 3:
                    self.dirty = False
                    last_save = time.time()
                    self.save()
            except Exception as e:
                log("Scheduler-Fehler: %s" % e)
            time.sleep(0.4)

    def shutdown(self):
        self.stop = True
        with self.lock:
            for jid, r in self.rt.items():
                r["cancel"] = True
                kill_tree(r.get("proc"))
        self.save()

    # ---- Ausfuehrung
    def add_log(self, j, line):
        line = line.rstrip()
        if not line:
            return
        lg = j["log"]
        lg.append(line[:500])
        if len(lg) > 400:
            del lg[: len(lg) - 400]
        j["last_line"] = line[:200]

    def run(self, j):
        jid = j["id"]
        try:
            if j["type"] == "compress":
                self.run_compress(j)
            elif j["tool"] == "ffmpeg":
                self.run_ffmpeg_download(j)
            else:
                self.run_ytdlp(j)
        except Exception as e:
            log("Job %s abgestürzt: %s" % (jid, e))
            self.fail(j, "Interner Fehler: %s" % e)
        finally:
            with self.lock:
                self.rt.pop(jid, None)
            self.trim()
            self.save()

    def canceled(self, j):
        r = self.rt.get(j["id"])
        return bool(r and r["cancel"])

    def fail(self, j, msg, hint=None):
        j["status"] = "failed"
        j["finished"] = time.time()
        j["error"] = msg
        j["hint"] = hint if hint is not None else hint_for(msg + " " + " ".join(j["log"][-15:]))
        j["speed"] = j["eta"] = ""
        j["phase"] = ""
        log("Job %s fehlgeschlagen: %s" % (j["id"], msg))

    def cancelled(self, j):
        j["status"] = "canceled"
        j["finished"] = time.time()
        j["speed"] = j["eta"] = ""
        j["phase"] = ""

    def verify(self, j, files):
        """Prueft, ob die Datei lesbar ist (Anfang und Ende dekodieren). Gibt Fehlertext oder None zurueck."""
        if not get_settings().get("verify_downloads", True):
            return None
        ff = find_ffmpeg("ffmpeg")
        if not ff:
            return None
        self.add_log(j, "Prüfe Datei…")
        for f in files:
            if Path(f).suffix.lower() not in (".mp4", ".mkv", ".webm", ".mov", ".m4a", ".mp3", ".ts", ".flv", ".avi", ".opus", ".ogg", ".aac"):
                continue
            for pre in (["-t", "20"], ["-sseof", "-10"]):
                try:
                    r = subprocess.run([ff, "-v", "error", "-xerror"] + pre + ["-i", str(f), "-f", "null", "-"], capture_output=True, text=True, errors="replace", timeout=180, **({"creationflags": 0x08000000} if IS_WIN else {}))
                except Exception:
                    return None
                if r.returncode != 0:
                    if "does not contain any stream" in r.stderr:
                        continue  # Ende-Pruefung bei sehr kurzen Dateien nicht aussagekraeftig
                    first = next((l for l in r.stderr.splitlines() if l.strip()), "unlesbare Daten")
                    self.add_log(j, "Prüfung: " + first)
                    return "Die Datei ist nicht lesbar (%s)." % first[:160]
        return None

    def succeed(self, j, files):
        bad = self.verify(j, files)
        if bad:
            return self.fail(j, bad, "Meist sind die Segmente verschlüsselt (AES-128 mit nicht abrufbarem Schlüssel, oder DRM). Bei AES-128 hilft oft yt-dlp statt ffmpeg. Bei DRM ist kein Download möglich. Die Datei bleibt zur Ansicht im Ordner.")
        j["status"] = "done"
        j["finished"] = time.time()
        j["progress"] = 100.0
        j["speed"] = j["eta"] = ""
        j["phase"] = ""
        j["files"] = [str(f) for f in files]
        j["dir"] = str(Path(files[0]).parent) if files else None
        j["size"] = sum(Path(f).stat().st_size for f in files if Path(f).exists())
        log("Job %s fertig: %s" % (j["id"], files[0] if files else "-"))

    def attach(self, j, proc):
        with self.lock:
            r = self.rt.get(j["id"])
            if r is not None:
                r["proc"] = proc
                if r["cancel"]:
                    kill_tree(proc)

    # -- yt-dlp
    def run_ytdlp(self, j):
        st = get_settings()
        cmdp = find_ytdlp()
        if not cmdp:
            return self.fail(j, "yt-dlp wurde nicht gefunden.", "Installiere yt-dlp (winget install yt-dlp) oder trage den Pfad in den Einstellungen ein.")
        base = Path(st["base_dir"])
        base.mkdir(parents=True, exist_ok=True)
        folder, name = resolve_names(j, st)
        rel = (folder + "/" if folder else "") + name + ".%(ext)s"
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        pf = TMP_DIR / ("%s.files.txt" % j["id"])
        if pf.exists():
            pf.unlink()
        cmd = cmdp + ["--encoding", "utf-8", "--color", "never", "--newline", "--progress", "--progress-template", PROG_TEMPLATE,
                      "--print-to-file", "after_move:%(filepath)s", str(pf), "--no-mtime", "--trim-filenames", "150", "-P", str(base), "-o", rel]
        if IS_WIN:
            cmd.append("--windows-filenames")
        cmd += j["argv"][1:]
        started = time.time()
        self.add_log(j, "> " + " ".join(cmd))
        proc = popen(cmd)
        self.attach(j, proc)
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            if line.startswith("[PROG] "):
                f = line[7:].split("|")
                if len(f) >= 8:
                    dl, total, est, speed, eta, fi, fc = (num(x) for x in f[:7])
                    pct = None
                    if total and total > 0 and dl is not None:
                        pct = dl / total * 100
                    elif est and est > 0 and dl is not None:
                        pct = min(99.0, dl / est * 100)
                    elif fc and fc > 1 and fi is not None:
                        pct = min(99.0, fi / fc * 100)
                    j["progress"] = round(pct, 1) if pct is not None else None
                    j["speed"] = fmt_speed(speed)
                    j["eta"] = fmt_eta(eta)
                    j["phase"] = "Lädt herunter…"
                continue
            self.add_log(j, line)
            if line.startswith("[Merger]") or line.startswith("[FixupM3u8]") or line.startswith("[FixupM4a]"):
                j["phase"] = "Fügt Video und Ton zusammen…"
            elif line.startswith("[ExtractAudio]"):
                j["phase"] = "Wandelt Ton um…"
            elif line.startswith(("[Metadata]", "[EmbedThumbnail]", "[EmbedSubtitle]", "[MoveFiles]", "[SponsorBlock]", "[ModifyChapters]")):
                j["phase"] = "Nachbearbeitung…"
            elif line.startswith("[info]") and "Downloading" in line:
                j["phase"] = "Bereitet vor…"
        rc = proc.wait()
        if self.canceled(j):
            return self.cancelled(j)
        files = []
        if pf.exists():
            for ln in pf.read_text(encoding="utf-8", errors="replace").splitlines():
                ln = ln.strip()
                if ln and Path(ln).is_file() and ln not in files:
                    files.append(ln)
            try:
                pf.unlink()
            except Exception:
                pass
        if rc == 0 and not files:
            newest = None
            for p in base.rglob("*"):
                if p.is_file() and p.stat().st_mtime >= started - 2 and not p.name.endswith((".part", ".ytdl", ".txt")):
                    if newest is None or p.stat().st_mtime > newest.stat().st_mtime:
                        newest = p
            if newest:
                files = [str(newest)]
        if rc == 0 and files:
            return self.succeed(j, files)
        if rc == 0:
            return self.fail(j, "yt-dlp meldet Erfolg, aber es wurde keine Datei gefunden.")
        err = next((l for l in reversed(j["log"]) if l.startswith("ERROR")), None) or (j["log"][-1] if j["log"] else "yt-dlp wurde mit Fehlercode %s beendet." % rc)
        self.fail(j, err)

    # -- ffmpeg als Downloader
    def run_ffmpeg_download(self, j):
        st = get_settings()
        ff = find_ffmpeg("ffmpeg")
        if not ff:
            return self.fail(j, "ffmpeg wurde nicht gefunden.", "Installiere ffmpeg (winget install ffmpeg) oder trage den Pfad in den Einstellungen ein.")
        base = Path(st["base_dir"])
        folder, name = resolve_names(j, st)
        name = sanitize_seg(strip_placeholders(name)) or "video"
        outdir = base / folder if folder else base
        outdir.mkdir(parents=True, exist_ok=True)
        out = unique_path(outdir / (name + "." + (j.get("ext") or "mp4")))
        args = [a for a in j["argv"][1:] if a != "-y"]
        clip = None
        try:
            ss = parse_time(args[args.index("-ss") + 1]) if "-ss" in args else None
            to = parse_time(args[args.index("-to") + 1]) if "-to" in args else None
            if ss is not None and to is not None:
                clip = max(0.0, to - ss)
            elif to is not None:
                clip = to
            clip_start = ss or 0.0
        except Exception:
            clip, clip_start = None, 0.0
        cmd = [ff, "-hide_banner", "-nostats", "-loglevel", "info", "-progress", "pipe:1", "-y"] + args + [str(out)]
        self.add_log(j, "> " + " ".join(cmd))
        self.stream_ffmpeg(j, cmd, clip, 0, 1)
        if self.canceled(j):
            self.cleanup(out)
            return self.cancelled(j)
        if j.pop("_rc", 1) == 0 and out.exists() and out.stat().st_size > 0:
            return self.succeed(j, [out])
        self.cleanup(out)
        err = next((l for l in reversed(j["log"]) if re.search(r"error|invalid|failed|denied|forbidden|not found", l, re.I)), None) or (j["log"][-1] if j["log"] else "ffmpeg ist fehlgeschlagen.")
        self.fail(j, err)

    def cleanup(self, *paths):
        for p in paths:
            try:
                if p and Path(p).exists():
                    Path(p).unlink()
            except Exception:
                pass

    def stream_ffmpeg(self, j, cmd, duration, pass_index, passes):
        """Startet ffmpeg, liest Fortschritt. Speichert Rueckgabecode in j['_rc'] und Dauer in j['_dur']."""
        proc = popen(cmd)
        self.attach(j, proc)
        dur = duration
        if "_dur" in j and dur is None:
            dur = j["_dur"]
        for line in proc.stdout:
            line = line.rstrip("\r\n")
            m = re.match(r"^(out_time_us|out_time_ms)=(-?\d+)$", line)
            if m:
                t = max(0, int(m.group(2))) / 1e6
                if dur and dur > 0:
                    frac = min(0.995, t / dur)
                    j["progress"] = round((pass_index + frac) / passes * 100, 1)
                    j["phase"] = ("Pass %d/%d: " % (pass_index + 1, passes) if passes > 1 else "") + "Verarbeitet…"
                else:
                    j["phase"] = "Verarbeitet %s…" % fmt_eta(t)
                continue
            m = re.match(r"^speed=\s*([\d.]+)x", line)
            if m:
                j["speed"] = "%sx" % m.group(1)
                if dur and dur > 0 and "progress" in j and j["progress"] is not None:
                    sp = float(m.group(1)) or 0
                    cur = (j["progress"] / 100 * passes - pass_index) * dur
                    j["eta"] = fmt_eta((dur - cur) / sp) if sp > 0 else ""
                continue
            if re.match(r"^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time|dup_frames|drop_frames|progress)=", line):
                continue
            if dur is None:
                m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", line)
                if m:
                    dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                    j["_dur"] = dur
            self.add_log(j, line)
        j["_rc"] = proc.wait()

    # -- Komprimieren
    def run_compress(self, j):
        st = get_settings()
        ff = find_ffmpeg("ffmpeg")
        if not ff:
            return self.fail(j, "ffmpeg wurde nicht gefunden.", "Installiere ffmpeg (winget install ffmpeg) oder trage den Pfad in den Einstellungen ein.")
        src = Path(j["input"])
        if not src.is_file():
            return self.fail(j, "Die Quelldatei existiert nicht mehr: %s" % src)
        preset = next((p for p in st["presets"] if p["name"] == j["preset"]), None)
        if not preset:
            return self.fail(j, "Preset „%s“ existiert nicht mehr." % j["preset"])
        suffix = sanitize_seg(st["compress_suffix"]) if st["compress_suffix"] else "_komprimiert"
        out = unique_path(src.with_name(src.stem + suffix + ".mp4"))
        dur = probe_duration(src)
        j["_dur"] = dur
        vf = []
        if preset["max_height"]:
            vf = ["-vf", "scale=w=-2:h='min(%d,ih)'" % preset["max_height"]]
        base = [ff, "-hide_banner", "-nostats", "-loglevel", "info", "-progress", "pipe:1", "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0"]
        venc = ["-c:v", preset["codec"], "-preset", preset["speed"], "-pix_fmt", "yuv420p"] + vf
        if preset["codec"] == "libx265":
            venc += ["-tag:v", "hvc1"]
        aenc = ["-c:a", "aac", "-b:a", "%dk" % preset["audio_kbps"]]
        tail = ["-movflags", "+faststart"]
        passlog = str(TMP_DIR / ("%s_pass" % j["id"]))
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        try:
            if preset["type"] == "size":
                if not dur:
                    return self.fail(j, "Die Länge des Videos konnte nicht ermittelt werden, Zielgröße geht nicht.")
                total_kbps = j["target_mb"] * 8192.0 / dur * 0.96
                vkbps = int(total_kbps - preset["audio_kbps"])
                if vkbps < 80:
                    return self.fail(j, "Die Zielgröße von %g MB ist für %s Länge zu klein." % (j["target_mb"], fmt_eta(dur)))
                rate = ["-b:v", "%dk" % vkbps, "-maxrate", "%dk" % int(vkbps * 1.5), "-bufsize", "%dk" % (vkbps * 2)]
                c1 = base + venc + rate + ["-pass", "1", "-passlogfile", passlog, "-an", "-f", "null", os.devnull]
                self.add_log(j, "> " + " ".join(c1))
                self.stream_ffmpeg(j, c1, dur, 0, 2)
                if self.canceled(j):
                    return self.cancelled(j)
                if j.pop("_rc", 1) != 0:
                    return self.fail(j, self.ff_error(j))
                c2 = base + venc + rate + ["-pass", "2", "-passlogfile", passlog] + aenc + tail + [str(out)]
                self.add_log(j, "> " + " ".join(c2))
                self.stream_ffmpeg(j, c2, dur, 1, 2)
            else:
                cmd = base + venc + ["-crf", str(preset["crf"])] + aenc + tail + [str(out)]
                self.add_log(j, "> " + " ".join(cmd))
                self.stream_ffmpeg(j, cmd, dur, 0, 1)
        finally:
            for p in TMP_DIR.glob("%s_pass*" % j["id"]):
                self.cleanup(p)
        if self.canceled(j):
            self.cleanup(out)
            return self.cancelled(j)
        if j.pop("_rc", 1) == 0 and out.is_file() and out.stat().st_size > 0:
            self.finish_compress(j, src, out)
            return
        self.cleanup(out)
        self.fail(j, self.ff_error(j))

    def ff_error(self, j):
        return next((l for l in reversed(j["log"]) if re.search(r"error|invalid|failed|denied|unable|not found", l, re.I)), None) or (j["log"][-1] if j["log"] else "ffmpeg ist fehlgeschlagen.")

    def finish_compress(self, j, src, out):
        old = src.stat().st_size if src.exists() else 0
        deleted = False
        if j.get("delete_original"):
            try:
                src.unlink()
                deleted = True
            except Exception as e:
                self.add_log(j, "Original konnte nicht gelöscht werden: %s" % e)
        self.succeed(j, [out])
        new = out.stat().st_size
        j["phase"] = ""
        self.add_log(j, "Größe: %s -> %s (%s)%s" % (human_size(old), human_size(new), ("-%d %%" % round((1 - new / old) * 100)) if old else "", ", Original gelöscht" if deleted else ""))
        j["saved_percent"] = round((1 - new / old) * 100) if old else None
        with self.lock:
            parent = self.jobs.get(j.get("parent"))
            if parent and deleted:
                parent["files"] = [str(out) if f == str(src) else f for f in parent.get("files", [])]


def human_size(n):
    n = float(n or 0)
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return ("%.0f %s" if u == "B" else "%.1f %s") % (n, u)
        n /= 1024.0


def probe_duration(path):
    fp = find_ffmpeg("ffprobe")
    if not fp:
        return None
    out = _run_quiet([fp, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], 30)
    try:
        v = float(out.splitlines()[0])
        return v if v > 0 else None
    except Exception:
        return None


# ----------------------------------------------------------------------------------------------
# Schnelle Jobs aus dem Dashboard
# ----------------------------------------------------------------------------------------------
def build_quick(url, mode, height, name):
    argv = ["yt-dlp", "--no-playlist"]
    hs = "[height<=?%d]" % height if height else ""
    if mode == "audio":
        argv += ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata"]
    else:
        argv += ["-f", "bv*%s+ba/b%s" % (hs, hs), "-S", "vcodec:h264,acodec:m4a", "--merge-output-format", "mp4", "--embed-metadata"]
    argv.append(url)
    return argv


# ----------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------
MANAGER = None
TOKEN = ""
PORT = DEFAULT_PORT
ALLOWED_HOSTS = set()

CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


def origin_ok(origin):
    if origin in ("http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT):
        return True
    return origin.startswith("moz-extension://") or origin.startswith("chrome-extension://")


def open_in_explorer(path):
    path = Path(path)
    try:
        if IS_WIN:
            if path.is_file():
                subprocess.Popen('explorer /select,"%s"' % path)
            else:
                subprocess.Popen(["explorer", str(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)] if path.is_file() else ["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent if path.is_file() else path)])
        return True
    except Exception as e:
        log("Ordner öffnen fehlgeschlagen: %s" % e)
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "m3u8-helper/" + VERSION

    def log_message(self, fmt, *args):
        pass

    # ---- Antworten
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(data)

    def err(self, code, msg):
        self.send(code, {"ok": False, "error": msg})

    # ---- Pruefungen
    def guard(self, need_token=True, post=False):
        host = (self.headers.get("Host") or "").lower()
        if host not in ALLOWED_HOSTS:
            self.err(403, "Ungültiger Host")
            return False
        origin = self.headers.get("Origin")
        if origin and not origin_ok(origin):
            self.err(403, "Ungültiger Ursprung")
            return False
        if post and not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            self.err(415, "Content-Type muss application/json sein")
            return False
        if need_token:
            auth = self.headers.get("Authorization") or ""
            tok = auth[7:] if auth.startswith("Bearer ") else ""
            if not tok or not hmac.compare_digest(tok, TOKEN):
                self.err(401, "Token fehlt oder ist falsch")
                return False
        return True

    def body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > 1024 * 1024:
            raise ValueError("Anfrage zu groß")
        raw = self.rfile.read(n) if n else b"{}"
        data = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(data, dict):
            raise ValueError("JSON-Objekt erwartet")
        return data

    # ---- GET
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/":
                if not self.guard(need_token=False):
                    return
                html = (APP_DIR / "dashboard.html").read_text(encoding="utf-8").replace("__TOKEN__", TOKEN).replace("__VERSION__", VERSION)
                return self.send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            if not self.guard():
                return
            if path == "/api/ping":
                return self.send(200, {"ok": True, "version": VERSION, "tools": tools_info(), "base_dir": get_settings()["base_dir"]})
            if path == "/api/state":
                return self.send(200, {"ok": True, "version": VERSION, "now": time.time(), "port": PORT, "tools": tools_info(), "settings": get_settings(), "jobs": MANAGER.snapshot()})
            m = re.match(r"^/api/jobs/([0-9a-f]{8})/log$", path)
            if m:
                j = MANAGER.jobs.get(m.group(1))
                if not j:
                    return self.err(404, "Job nicht gefunden")
                return self.send(200, {"ok": True, "log": list(j.get("log") or [])})
            self.err(404, "Nicht gefunden")
        except Exception as e:
            log("GET %s: %s" % (path, e))
            self.err(500, "Interner Fehler")

    # ---- POST
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not self.guard(post=True):
                return
            try:
                data = self.body()
            except Exception as e:
                return self.err(400, "Ungültige Anfrage: %s" % e)

            if path == "/api/jobs":
                force = bool(data.pop("force", False)) if isinstance(data, dict) else False
                fields, error = validate_payload(data)
                if error:
                    return self.err(400, error)
                dup = None if force else MANAGER.find_duplicate(fields["url"])
                if dup:
                    labels = {"queued": "wartet schon", "running": "wird schon heruntergeladen", "done": "wurde schon heruntergeladen"}
                    return self.send(409, {"ok": False, "duplicate": True, "id": dup[0], "status": dup[1], "error": "Diese URL %s." % labels.get(dup[1], "ist schon vorhanden")})
                if not fields["title"]:
                    fields["title"] = urlparse(fields["url"]).netloc
                j = MANAGER.add_download(fields)
                log("Neuer Job %s (%s): %s" % (j["id"], fields["tool"], fields["url"][:120]))
                return self.send(200, {"ok": True, "id": j["id"]})

            if path == "/api/jobs/quick":
                url = str(data.get("url") or "").strip()
                if not URL_RE.match(url):
                    return self.err(400, "Bitte eine gültige URL (http oder https) angeben")
                mode = "audio" if data.get("mode") == "audio" else "av"
                try:
                    height = int(data.get("height") or 0)
                except Exception:
                    height = 0
                if height not in (0, 360, 480, 720, 1080, 1440, 2160):
                    height = 0
                name = str(data.get("name") or "").strip()[:200] or None
                site = urlparse(url).hostname or ""
                site = re.sub(r"^www\.", "", site)
                j = MANAGER.add_download({"tool": "ytdlp", "argv": build_quick(url, mode, height, name), "kind": "page", "url": url, "site": site if re.match(r"^[A-Za-z0-9.-]{1,100}$", site) else "", "title": url, "name_override": name})
                return self.send(200, {"ok": True, "id": j["id"]})

            if path == "/api/settings":
                with _settings_lock:
                    new, errs = clean_settings(data, SETTINGS)
                    if errs:
                        return self.err(400, "; ".join(errs))
                    SETTINGS.clear()
                    SETTINGS.update(new)
                save_json(SETTINGS_FILE, new)
                _tools_cache["val"] = None
                return self.send(200, {"ok": True, "settings": get_settings(), "tools": tools_info(True)})

            if path == "/api/jobs/clear":
                MANAGER.clear_finished()
                return self.send(200, {"ok": True})

            m = re.match(r"^/api/jobs/([0-9a-f]{8})/(cancel|retry|delete|compress|open|rename)$", path)
            if not m:
                return self.err(404, "Nicht gefunden")
            jid, action = m.group(1), m.group(2)
            if jid not in MANAGER.jobs:
                return self.err(404, "Job nicht gefunden")
            if action == "cancel":
                MANAGER.cancel(jid)
                return self.send(200, {"ok": True})
            if action == "retry":
                return self.send(200, {"ok": MANAGER.retry(jid)})
            if action == "delete":
                MANAGER.remove(jid)
                return self.send(200, {"ok": True})
            if action == "compress":
                ids, error = MANAGER.add_compress(jid, str(data.get("preset") or ""), data.get("target_mb"), bool(data.get("delete_original")))
                if error:
                    return self.err(400, error)
                return self.send(200, {"ok": True, "ids": ids})
            if action == "rename":
                new, error = MANAGER.rename(jid, data.get("name"))
                if error:
                    return self.err(400, error)
                return self.send(200, {"ok": True, "file": new, "name": Path(new).name})
            if action == "open":
                j = MANAGER.jobs[jid]
                target = (j.get("files") or [None])[0] or j.get("dir")
                if not target:
                    return self.err(400, "Noch keine Datei vorhanden")
                base = Path(get_settings()["base_dir"]).resolve()
                try:
                    Path(target).resolve().relative_to(base)
                except Exception:
                    if not Path(target).parent.exists() or Path(target).parent.resolve() != Path(j.get("dir") or "").resolve():
                        return self.err(400, "Pfad liegt außerhalb des Download-Ordners")
                return self.send(200, {"ok": open_in_explorer(target)})
            self.err(404, "Nicht gefunden")
        except Exception as e:
            log("POST %s: %s" % (path, e))
            self.err(500, "Interner Fehler")

    def do_OPTIONS(self):
        # Kein CORS: fremde Webseiten bekommen keine Freigabe.
        self.err(403, "Nicht erlaubt")


# ----------------------------------------------------------------------------------------------
# Start
# ----------------------------------------------------------------------------------------------
class PortBusy(Exception):
    pass


def setup_server(port=None):
    """Bereitet Einstellungen vor und startet Manager und HTTP-Server (noch ohne serve_forever)."""
    global MANAGER, TOKEN, PORT, ALLOWED_HOSTS
    HOME.mkdir(parents=True, exist_ok=True)
    cfg = load_json(CONFIG_FILE, {})
    first_run = not cfg.get("token")
    if first_run:
        cfg["token"] = secrets.token_urlsafe(24)
    if port:
        cfg["port"] = port
    cfg.setdefault("port", DEFAULT_PORT)
    save_json(CONFIG_FILE, cfg)
    TOKEN = cfg["token"]
    PORT = int(cfg["port"])
    ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}

    load_settings()
    Path(get_settings()["base_dir"]).mkdir(parents=True, exist_ok=True)
    MANAGER = Manager()
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        raise PortBusy("Der Port %d ist nicht verfügbar (%s). Läuft der Helfer schon? Mit --port eine andere Nummer wählen." % (PORT, e))
    httpd.daemon_threads = True
    MANAGER.start()
    return httpd, first_run


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="m3u8-Helfer: lokaler Download-Server für das Firefox-Add-on")
    ap.add_argument("--port", type=int, help="Port (Standard %d)" % DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true", help="Dashboard nicht automatisch öffnen")
    args = ap.parse_args()

    try:
        httpd, first_run = setup_server(args.port)
    except PortBusy as e:
        log(str(e))
        sys.exit(1)

    url = "http://127.0.0.1:%d/" % PORT
    t = tools_info(True)
    log("m3u8-Helfer %s läuft: %s" % (VERSION, url))
    log("Download-Ordner: %s" % get_settings()["base_dir"])
    log("yt-dlp: %s | ffmpeg: %s" % (t["ytdlp"]["version"] or "NICHT GEFUNDEN", (t["ffmpeg"]["version"] or "NICHT GEFUNDEN")[:40]))
    log("Dieses Fenster offen lassen. Beenden mit Strg+C.")
    if first_run and not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    def stop(*_):
        log("Beende…")
        MANAGER.shutdown()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    try:
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        stop()
    finally:
        MANAGER.shutdown()


if __name__ == "__main__":
    main()
