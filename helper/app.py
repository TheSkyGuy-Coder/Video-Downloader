"""m3u8-Helfer als Desktop-App: Fenster mit dem Dashboard, Tray-Symbol, optional Autostart.

Start:  python app.py [--minimized] [--port N] [--browser]
        --minimized  beim Start nur im Tray (z. B. bei Autostart)
        --browser    Dashboard im normalen Browser statt im App-Fenster
"""
import argparse
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import helper

APP_NAME = "m3u8-Helfer"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "m3u8-Helfer"

try:
    import webview  # pywebview
except Exception:  # pragma: no cover
    webview = None
try:
    from PIL import Image, ImageDraw
except Exception:  # pragma: no cover
    Image = ImageDraw = None
try:
    import pystray
except Exception:  # pragma: no cover
    pystray = None
if Image is None:
    pystray = None  # ohne Pillow kein Symbol, also auch kein Tray


# ---------------------------------------------------------------- Symbol
def make_icon(size=64):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size // 6
    d.rounded_rectangle((2, 2, size - 3, size - 3), radius=r * 2, fill=(26, 115, 232, 255))
    cx = size // 2
    d.rectangle((cx - size // 14, size * 0.2, cx + size // 14, size * 0.52), fill="white")
    d.polygon([(cx - size * 0.22, size * 0.5), (cx + size * 0.22, size * 0.5), (cx, size * 0.74)], fill="white")
    d.rectangle((size * 0.24, size * 0.78, size * 0.76, size * 0.84), fill="white")
    return img


# ---------------------------------------------------------------- Autostart (Windows)
def autostart_command():
    if getattr(sys, "frozen", False):
        return '"%s" --minimized' % sys.executable
    exe = sys.executable
    pyw = Path(exe).with_name("pythonw.exe")
    if pyw.is_file():
        exe = str(pyw)
    return '"%s" "%s" --minimized' % (exe, Path(__file__).resolve())


def autostart_supported():
    return os.name == "nt"


def autostart_enabled():
    if not autostart_supported():
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return bool(winreg.QueryValueEx(k, RUN_VALUE)[0])
    except OSError:
        return False


def set_autostart(on):
    if not autostart_supported():
        return False
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_VALUE)
            except FileNotFoundError:
                pass
    return True


# ---------------------------------------------------------------- Hilfsfunktionen
def open_path(path):
    path = str(path)
    try:
        if os.name == "nt":
            os.startfile(path)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        helper.log("Konnte %s nicht öffnen: %s" % (path, e))


class App:
    def __init__(self, args):
        self.args = args
        self.httpd = None
        self.window = None
        self.tray = None
        self.quitting = False
        self.url = ""

    # -- Server
    def start_server(self):
        self.httpd, first_run = helper.setup_server(self.args.port)
        self.url = "http://127.0.0.1:%d/" % helper.PORT
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="http").start()
        t = helper.tools_info(True)
        helper.log("%s %s läuft: %s" % (APP_NAME, helper.VERSION, self.url))
        helper.log("yt-dlp: %s | ffmpeg: %s" % (t["ytdlp"]["version"] or "NICHT GEFUNDEN", (t["ffmpeg"]["version"] or "NICHT GEFUNDEN")[:40]))
        return first_run

    # -- Fenster
    def show(self):
        if self.window is not None:
            try:
                self.window.show()
                self.window.restore()
                return
            except Exception as e:
                helper.log("Fenster anzeigen: %s" % e)
        webbrowser.open(self.url)

    def on_closing(self):
        """Fenster schließen = in den Tray verschieben (nur wenn es einen Tray gibt)."""
        if self.quitting or self.tray is None:
            return True
        try:
            self.window.hide()
        except Exception:
            return True
        return False

    # -- Tray
    def update_ytdlp(self):
        cmd = helper.find_ytdlp()
        if not cmd or len(cmd) > 1:
            self.notify("yt-dlp-Update geht nur mit einer eigenständigen yt-dlp.exe (Ordner „tools“ oder PATH).")
            return

        def work():
            try:
                r = subprocess.run(cmd + ["-U"], capture_output=True, text=True, errors="replace", timeout=300,
                                   creationflags=helper.CREATE_NO_WINDOW if os.name == "nt" else 0)
                lines = [l for l in (r.stdout + r.stderr).splitlines() if l.strip()]
                self.notify(lines[-1] if lines else "yt-dlp-Update beendet.")
                helper.tools_info(True)
            except Exception as e:
                self.notify("yt-dlp-Update fehlgeschlagen: %s" % e)

        threading.Thread(target=work, daemon=True).start()

    def notify(self, msg):
        helper.log(msg)
        try:
            if self.tray:
                self.tray.notify(msg, APP_NAME)
        except Exception:
            pass

    def toggle_autostart(self, icon=None, item=None):
        try:
            set_autostart(not autostart_enabled())
        except Exception as e:
            self.notify("Autostart ändern fehlgeschlagen: %s" % e)

    def start_tray(self):
        if pystray is None:
            return
        menu = pystray.Menu(
            pystray.MenuItem("Öffnen", lambda i, it: self.show(), default=True),
            pystray.MenuItem("Download-Ordner öffnen", lambda i, it: open_path(helper.get_settings()["base_dir"])),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Mit Windows starten", self.toggle_autostart, checked=lambda it: autostart_enabled(), enabled=autostart_supported()),
            pystray.MenuItem("yt-dlp aktualisieren", lambda i, it: self.update_ytdlp()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Beenden", lambda i, it: self.quit()),
        )
        self.tray = pystray.Icon("m3u8-helper", make_icon(64), APP_NAME, menu)
        self.tray.run_detached()

    # -- Beenden
    def quit(self):
        if self.quitting:
            return
        self.quitting = True
        helper.log("Beende…")
        try:
            helper.MANAGER.shutdown()
        except Exception:
            pass
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        try:
            if self.window is not None:
                self.window.destroy()
        except Exception:
            pass
        self.done.set()

    # -- Ablauf
    def run(self):
        self.done = threading.Event()
        try:
            first_run = self.start_server()
        except helper.PortBusy:
            helper.log("%s läuft schon, öffne das vorhandene Dashboard." % APP_NAME)
            webbrowser.open("http://127.0.0.1:%d/" % helper.PORT)
            return 0

        use_window = webview is not None and not self.args.browser
        self.start_tray()
        start_hidden = self.args.minimized and self.tray is not None

        if not use_window:
            if not start_hidden:
                webbrowser.open(self.url)
            if self.tray is None:
                helper.log("Weder Fenster noch Tray verfügbar. Beenden mit Strg+C.")
            try:
                while not self.done.wait(0.5):
                    pass
            except KeyboardInterrupt:
                self.quit()
            return 0

        self.window = webview.create_window(APP_NAME, self.url, width=1180, height=780, min_size=(760, 520), hidden=start_hidden)
        self.window.events.closing += self.on_closing
        try:
            webview.start()  # blockiert bis das letzte Fenster zerstört ist
        finally:
            self.quit()
        return 0


def main():
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--port", type=int)
    ap.add_argument("--minimized", action="store_true", help="nur im Tray starten")
    ap.add_argument("--browser", action="store_true", help="Dashboard im Browser statt im App-Fenster")
    args = ap.parse_args()
    return App(args).run()


if __name__ == "__main__":
    sys.exit(main())
