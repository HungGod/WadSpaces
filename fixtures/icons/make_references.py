#!/usr/bin/env python3
"""The icons wad-icons is held to: inputs drawn here, and the cards
KaleBrowser's packager.py made of them (its process_icon_to_card).

    python3 fixtures/icons/make_references.py <path to packager.py>

packager.py went with the Electron app; it's in git history under
apps/wadbrowser/packager/ (and HungGod/KaleBrowser). Needs Pillow only: the
packager's network modules are stubbed, nothing is fetched.
"""
import importlib.util
import os
import sys
import types

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

for name in ("requests", "bs4"):
    stub = types.ModuleType(name)
    stub.BeautifulSoup = object
    sys.modules[name] = stub
spec = importlib.util.spec_from_file_location("packager", sys.argv[1])
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def dark_on_light():
    im = Image.new("RGBA", (64, 64), (255, 255, 255, 255))
    d = ImageDraw.Draw(im)
    d.polygon([(8, 14), (18, 50), (32, 26), (46, 50), (56, 14), (48, 14), (44, 36), (32, 16), (20, 36), (16, 14)], fill=(20, 20, 30, 255))
    return im


def light_on_dark():
    im = Image.new("RGBA", (64, 64), (36, 41, 46, 255))
    d = ImageDraw.Draw(im)
    d.ellipse([12, 12, 52, 52], fill=(250, 250, 250, 255))
    d.ellipse([22, 22, 42, 42], fill=(36, 41, 46, 255))
    d.rectangle([28, 40, 36, 56], fill=(250, 250, 250, 255))
    return im


def transparent_logo():
    im = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pts = []
    import math
    for i in range(16):
        r = 44 if i % 2 == 0 else 16
        a = math.pi * 2 * i / 16
        pts.append((48 + r * math.cos(a), 48 + r * math.sin(a)))
    d.polygon(pts, fill=(217, 119, 87, 255))
    return im


def light_plate():
    im = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([4, 4, 124, 124], fill=(255, 255, 255, 255))
    for start, colour in ((-40, (66, 133, 244)), (40, (52, 168, 83)), (130, (251, 188, 5)), (200, (234, 67, 53))):
        d.arc([30, 30, 98, 98], start, start + 80, fill=colour + (255,), width=16)
    d.rectangle([64, 58, 98, 70], fill=(66, 133, 244, 255))
    return im


def tiny():
    im = Image.new("RGBA", (16, 16), (24, 119, 242, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([7, 3, 10, 13], fill=(255, 255, 255, 255))
    d.rectangle([5, 6, 11, 8], fill=(255, 255, 255, 255))
    return im


def wide():
    im = Image.new("RGBA", (200, 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, x in enumerate(range(10, 190, 36)):
        d.rounded_rectangle([x, 15 + (i % 2) * 10, x + 26, 65], radius=6, fill=(30, 30, 30, 255))
    return im


def low_contrast():
    im = Image.new("RGBA", (48, 48), (136, 136, 136, 255))
    d = ImageDraw.Draw(im)
    d.polygon([(24, 6), (42, 40), (6, 40)], fill=(85, 85, 85, 255))
    return im


if __name__ == "__main__":
    for make in (dark_on_light, light_on_dark, transparent_logo, light_plate, tiny, wide, low_contrast):
        name = make.__name__.replace("_", "-")
        src = os.path.join(HERE, f"{name}.png")
        make().save(src)
        with open(src, "rb") as f:
            packager.process_icon_to_card(f.read()).save(os.path.join(HERE, f"{name}.card.png"))
        print(name)
