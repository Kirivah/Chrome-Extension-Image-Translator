import json
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
SERIF = SANS = None
for cand in ["/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]:
    if Path(cand).exists():
        SERIF = SERIF or cand
for cand in ["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]:
    if Path(cand).exists():
        SANS = SANS or cand
assert SERIF and SANS, "need Noto CJK fonts"
rng = random.Random(7)


def font(size, serif=True):
    return ImageFont.truetype(SERIF if serif else SANS, size, index=0)


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def ink_box(img, box, dark=True):
    x0, y0, x1, y1 = box
    px = img.load()
    xs, ys = [], []
    for y in range(max(0, y0), min(img.height, y1)):
        for x in range(max(0, x0), min(img.width, x1)):
            r, g, b = px[x, y][:3]
            lum = (r * 299 + g * 587 + b * 114) / 1000
            if (lum < 110) if dark else (lum > 150):
                xs.append(x)
                ys.append(y)
    return [min(xs), min(ys), max(xs) + 1, max(ys) + 1]


def column(d, x, y, text, size, fill=(0, 0, 0), serif=True, ruby=None):
    f = font(size, serif)
    boxes = []
    step = int(size * 1.08)
    for i, ch in enumerate(text):
        cy = y + i * step
        if ch in "ー":
            d.line([x + size // 2, cy + 3, x + size // 2, cy + size - 3], fill=fill, width=max(2, size // 9))
            boxes.append([x + size // 2 - 2, cy + 3, x + size // 2 + 2, cy + size - 3])
            continue
        d.text((x, cy), ch, font=f, fill=fill)
        boxes.append(list(d.textbbox((x, cy), ch, font=f)))
        if ruby and i in ruby:
            rs = max(9, size * 2 // 5)
            rf = font(rs, serif)
            for j, rch in enumerate(ruby[i]):
                ry = cy + j * rs - 2
                d.text((x + size + 2, ry), rch, font=rf, fill=fill)
                boxes.append(list(d.textbbox((x + size + 2, ry), rch, font=rf)))
    return boxes


def block_v(d, x_right, y, lines, size, rubies=None, **kw):
    boxes = []
    gap = int(size * 0.45)
    for k, line in enumerate(lines):
        x = x_right - (k + 1) * size - k * gap
        boxes += column(d, x, y, line, size, ruby=(rubies or {}).get(k), **kw)
    return boxes


def ellipse_bubble(d, cx, cy, rx, ry, outline=4, fill=(255, 255, 255)):
    d.ellipse([cx - rx - outline, cy - ry - outline, cx + rx + outline, cy + ry + outline], fill=(0, 0, 0))
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=fill)


def hatch(d, box, spacing=7, angle=1, width=2, shade=40):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    layer = Image.new("L", (w, h), 0)
    ld = ImageDraw.Draw(layer)
    for k in range(-h, w, spacing):
        ld.line([k, 0 if angle > 0 else h, k + h, h if angle > 0 else 0], fill=255, width=width)
    d.bitmap((x0, y0), layer, fill=(shade, shade, shade))


def screentone(d, box, step=6, r=1.6):
    x0, y0, x1, y1 = box
    for y in range(y0, y1, step):
        off = (step // 2) if ((y - y0) // step) % 2 else 0
        for x in range(x0 + off, x1, step):
            d.ellipse([x - r, y - r, x + r, y + r], fill=(0, 0, 0))


def gradient(img, box, a, b):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        t = (y - y0) / max(1, y1 - y0 - 1)
        c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
        d.line([x0, y, x1 - 1, y], fill=c)


def scribbles(d, box, n=40, shade=30):
    x0, y0, x1, y1 = box
    for _ in range(n):
        x, y = rng.randint(x0, x1), rng.randint(y0, y1)
        pts = [(x, y)]
        for _ in range(6):
            x = min(x1, max(x0, x + rng.randint(-40, 40)))
            y = min(y1, max(y0, y + rng.randint(-40, 40)))
            pts.append((x, y))
        d.line(pts, fill=(shade, shade, shade), width=rng.randint(2, 5), joint="curve")


truth = {}
SIZES = {"hello": 36, "nah": 38, "bugs": 32, "narration": 30, "openwhite": 34, "thanks": 34, "sfx": 90,
         "inverted": 28, "row0": 34, "row1": 34, "row2": 34, "border": 34, "grey": 30, "tall": 34,
         "tight": 36, "band": 40, "touch": 36, "blackbox": 32}


def page_a():
    img = Image.new("RGB", (800, 1100), "white")
    d = ImageDraw.Draw(img)
    for box in ([20, 20, 780, 520], [20, 540, 395, 1080], [415, 540, 780, 1080]):
        d.rectangle(box, outline=(0, 0, 0), width=5)
    gradient(img, (26, 26, 774, 260), (210, 210, 210), (150, 150, 150))
    d = ImageDraw.Draw(img)
    hatch(d, (26, 260, 774, 514), spacing=9)
    scribbles(d, (40, 280, 760, 500), n=30)
    screentone(d, (26, 546, 389, 760))
    scribbles(d, (40, 780, 380, 1060), n=25)
    hatch(d, (421, 860, 774, 1074), spacing=8, angle=-1)
    blocks = []

    ellipse_bubble(d, 150, 170, 95, 125)
    g = block_v(d, 196, 85, ["こんにちは", "元気かい"], 36, rubies={1: {0: "げん", 1: "き"}})
    blocks.append(("hello", g))

    ellipse_bubble(d, 360, 120, 45, 75)
    g = block_v(d, 380, 70, ["いや"], 38)
    blocks.append(("nah", g))

    ellipse_bubble(d, 560, 185, 125, 160)
    g = block_v(d, 625, 80, ["虫とかイヤだ", "なんか強そうな", "のがいいな"], 32)
    blocks.append(("bugs", g))

    d.rectangle([250, 560, 380, 760], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
    g = block_v(d, 365, 575, ["その日から", "すべてが"], 30, serif=False)
    blocks.append(("narration", g))

    g = block_v(d, 760, 560, ["此処ではない"], 34)
    blocks.append(("openwhite", g))

    ellipse_bubble(d, 200, 940, 140, 60)
    t = []
    f = font(34)
    d.text((95, 920), "ありがとう！", font=f, fill=(0, 0, 0))
    t.append(list(d.textbbox((95, 920), "ありがとう！", font=f)))
    blocks.append(("thanks", t))

    f = font(90, serif=False)
    d.text((470, 610), "ドン", font=f, fill=(255, 255, 255), stroke_width=6, stroke_fill=(0, 0, 0))
    blocks.append(("sfx", [list(d.textbbox((470, 610), "ドン", font=f, stroke_width=6))]))

    d.rectangle([440, 760, 640, 840], fill=(10, 10, 10))
    f = font(28, serif=False)
    d.text((462, 783), "三日後…", font=f, fill=(255, 255, 255))
    blocks.append(("inverted", [list(d.textbbox((462, 783), "三日後…", font=f))]))

    img.save(OUT / "page-a.png", optimize=True)
    truth["page-a.png"] = {"w": img.width, "h": img.height, "blocks": [
        {"id": k, "box": ink_box(img, union(bs), dark=k != "inverted"), "size": SIZES[k]} for k, bs in blocks]}


def page_b():
    img = Image.new("RGB", (700, 1000), "white")
    d = ImageDraw.Draw(img)
    for box in ([15, 15, 685, 480], [15, 500, 685, 985]):
        d.rectangle(box, outline=(0, 0, 0), width=5)
    hatch(d, (21, 21, 679, 474), spacing=6)
    gradient(img, (21, 506, 679, 979), (235, 235, 235), (120, 120, 120))
    d = ImageDraw.Draw(img)
    scribbles(d, (30, 520, 670, 970), n=45, shade=20)
    blocks = []
    for k, (cx, txt) in enumerate([(120, ["スキル"]), (235, ["なし？"]), (350, ["ウソ"])]):
        ellipse_bubble(d, cx, 120, 48, 85)
        g = block_v(d, cx + 18, 60, txt, 34)
        blocks.append((f"row{k}", g))
    ellipse_bubble(d, 560, 470, 110, 105)
    g = block_v(d, 610, 395, ["決めた！", "おれは"], 34)
    blocks.append(("border", g))
    ellipse_bubble(d, 200, 760, 120, 110, fill=(225, 225, 225))
    g = block_v(d, 250, 680, ["ここは", "異世界だろ"], 30, rubies={1: {1: "せ", 2: "かい"}})
    blocks.append(("grey", g))
    ellipse_bubble(d, 520, 760, 55, 175)
    g = block_v(d, 538, 610, ["戦闘系とかか…？"], 34)
    blocks.append(("tall", g))
    img.save(OUT / "page-b.png", optimize=True)
    truth["page-b.png"] = {"w": img.width, "h": img.height,
                           "blocks": [{"id": k, "box": ink_box(img, union(bs)), "size": SIZES[k]} for k, bs in blocks]}


def noise_art(img, box, step=6):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            g = int(60 + 120 * (y - y0) / max(1, y1 - y0))
            c = (min(255, g + rng.randint(-60, 60)), min(255, max(0, g - 30 + rng.randint(-50, 50))),
                 min(255, max(0, 180 - g // 2 + rng.randint(-60, 60))))
            d.rectangle([x, y, min(x1, x + step) - 1, min(y1, y + step) - 1], fill=c)


def mask_ink(img, draws):
    layer = Image.new("L", img.size, 0)
    ld = ImageDraw.Draw(layer)
    for xy, text, f in draws:
        ld.text(xy, text, font=f, fill=255)
    return list(layer.point(lambda v: 255 if v > 145 else 0).getbbox())


def page_c():
    img = Image.new("RGB", (700, 900), "white")
    noise_art(img, (0, 0, 700, 900))
    d = ImageDraw.Draw(img)
    blocks = []
    f = font(36)
    d.rectangle([60, 40, 330, 120], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    xy = (140, 72)
    ink = mask_ink(img, [(xy, "翌日", f)])
    d.rectangle([60, 40, 330, ink[3] + 8 + 4], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
    d.text(xy, "翌日", font=f, fill=(0, 0, 0))
    blocks.append(("tight", ink))
    f = font(40)
    xy = (380, 30)
    ink = mask_ink(img, [(xy, "月曜日の朝", f)])
    d.rectangle([360, 0, 700, ink[3] + 12 - 1], fill=(255, 255, 255))
    d.text(xy, "月曜日の朝", font=f, fill=(0, 0, 0))
    blocks.append(("band", ink))
    f = font(36)
    step = int(36 * 1.05)
    draws = [((200, 260 + i * step), ch, f) for i, ch in enumerate("こんにちは")]
    ink = mask_ink(img, draws)
    cx, rx, ry = 218, 110, 130
    cy = ink[3] - ry + 1
    ellipse_bubble(d, cx, cy, rx, ry)
    for xy, ch, ff in draws:
        d.text(xy, ch, font=ff, fill=(0, 0, 0))
    blocks.append(("touch", ink))
    f = font(32, serif=False)
    d.rectangle([400, 560, 640, 640], fill=(10, 10, 10))
    xy = (440, 582)
    ink = mask_ink(img, [(xy, "そうかい", f)])
    d.text(xy, "そうかい", font=f, fill=(255, 255, 255))
    blocks.append(("blackbox", ink))
    img.save(OUT / "page-c.png", optimize=True)
    truth["page-c.png"] = {"w": img.width, "h": img.height,
                           "blocks": [{"id": k, "box": b, "size": SIZES[k]} for k, b in blocks]}


page_a()
page_b()
page_c()
(OUT / "pages.json").write_text(json.dumps(truth, indent=1))
for name in truth:
    print(name, (OUT / name).stat().st_size // 1024, "KB", [b["id"] for b in truth[name]["blocks"]])
