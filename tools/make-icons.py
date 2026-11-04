#!/usr/bin/env python3
"""Generate Connect All icons: 32x32 1-bit pixel art, upscaled to app icons."""
import os
import subprocess
from PIL import Image, ImageDraw

BASE = 32
SCALE = 32
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
os.makedirs(BUILD, exist_ok=True)

# 1 = black, 0 = white, 2 = transparent
def new_canvas():
    return [[0] * BASE for _ in range(BASE)]

def rect(g, x0, y0, x1, y1, val=1):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= x < BASE and 0 <= y < BASE:
                g[y][x] = val

def outline(g, x0, y0, x1, y1, val=1):
    for x in range(x0, x1 + 1):
        if 0 <= y0 < BASE:
            g[y0][x] = val
        if 0 <= y1 < BASE:
            g[y1][x] = val
    for y in range(y0, y1 + 1):
        if 0 <= x0 < BASE:
            g[y][x0] = val
        if 0 <= x1 < BASE:
            g[y][x1] = val

def dither(g, x0, y0, x1, y1):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if (x + y) % 2 == 0:
                g[y][x] = 1

def bubble(g, x0, y0, x1, y1, tail_x, tail_y):
    # body
    outline(g, x0, y0, x1, y1, 1)
    # tail: 4px wide triangle pointing down
    for i in range(4):
        for x in range(tail_x, tail_x + 4 - i):
            y = tail_y + i
            if 0 <= y < BASE and 0 <= x < BASE:
                g[y][x] = 1
    # clear interior
    for y in range(y0 + 2, y1 - 0):
        for x in range(x0 + 2, x1 - 0):
            g[y][x] = 0

def make_icon():
    g = new_canvas()
    # paper with hard black frame + 1px dither margin
    rect(g, 1, 1, 30, 30, 1)
    rect(g, 2, 2, 29, 29, 0)
    dither(g, 3, 3, 28, 28)
    rect(g, 3, 3, 28, 28, 0)
    # window title stripes
    for y in range(4, 8):
        for x in range(4, 28):
            g[y][x] = 1 if y % 2 == 0 else 0
    # close box
    rect(g, 5, 4, 8, 7, 0)
    outline(g, 5, 4, 8, 7, 1)
    # bubbles
    bubble(g, 8, 12, 21, 22, 11, 23)
    bubble(g, 15, 8, 27, 18, 23, 19)
    # bubble A drawn on top again for interlock
    bubble(g, 8, 12, 21, 22, 11, 23)
    # dots in front bubble
    for x in (11, 14, 17):
        rect(g, x, 16, x + 1, 17, 1)
    # small heart on back bubble
    for (x, y) in [(22, 11), (23, 11), (25, 11), (26, 11), (22, 12), (23, 12), (24, 12), (25, 12), (26, 12), (23, 13), (24, 13), (25, 13), (24, 14)]:
        rect(g, x, y, x, y, 1)
    # baseline shadow
    for x in range(8, 27):
        if g[29][x] == 0:
            g[29][x] = 1
    return g

def to_image(g, scale=SCALE):
    img = Image.new("RGBA", (BASE * scale, BASE * scale), (0, 0, 0, 0))
    px = img.load()
    for y in range(BASE):
        for x in range(BASE):
            v = g[y][x]
            if v == 2:
                continue
            color = (0, 0, 0, 255) if v == 1 else (255, 255, 255, 255)
            for dy in range(scale):
                for dx in range(scale):
                    px[x * scale + dx, y * scale + dy] = color
    return img

def save(img, name):
    img.save(os.path.join(BUILD, name))

def main():
    g = make_icon()
    big = to_image(g, 32)  # 1024
    save(big, "icon.png")
    sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    for s in sizes:
        save(to_image(g, s // BASE if s >= BASE else 1).resize((s, s), Image.NEAREST), f"icon-{s}.png")
    # iconset for icns
    iconset = os.path.join(BUILD, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    mapping = {
        "icon_16x16.png": 16, "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
    }
    for filename, s in mapping.items():
        save(to_image(g, s // BASE if s >= BASE else 1).resize((s, s), Image.NEAREST), os.path.join("icon.iconset", filename))
    if subprocess.call(["which", "iconutil"], stdout=subprocess.DEVNULL) == 0:
        subprocess.call(["iconutil", "-c", "icns", iconset, "-o", os.path.join(BUILD, "icon.icns")])
    # ico
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base = to_image(g, 8)  # 256
    base.save(os.path.join(BUILD, "icon.ico"), sizes=ico_sizes)
    # tray icon: transparent background, white pixels for macOS template
    tray = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    for y in range(32):
        for x in range(32):
            if 2 <= x <= 29 and 2 <= y <= 29 and g[y][x] == 1:
                tray.putpixel((x, y), (0, 0, 0, 255))
    tray.save(os.path.join(BUILD, "trayTemplate.png"))
    tray.resize((16, 16), Image.NEAREST).save(os.path.join(BUILD, "trayTemplate@2x.png"))
    print("icons written to", BUILD)

if __name__ == "__main__":
    main()
