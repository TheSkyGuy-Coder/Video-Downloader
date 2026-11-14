"""Erzeugt icon.ico fuer die .exe (benoetigt Pillow)."""
import app

img = app.make_icon(256)
img.save("icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon.ico erzeugt")
