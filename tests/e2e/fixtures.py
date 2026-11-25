import json
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "www"
OUT.mkdir(exist_ok=True)
CJK = None
for cand in ["/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"]:
    if Path(cand).exists():
        CJK = cand
        break
assert CJK, "need a CJK font"
random.seed(42)


def font(size):
    return ImageFont.truetype(CJK, size, index=0)


def art(img, box):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    for y in range(y0, y1, 6):
        for x in range(x0, x1, 6):
            g = int(60 + 120 * (y - y0) / max(1, y1 - y0))
            c = (min(255, g + random.randint(-60, 60)), min(255, max(0, g - 30 + random.randint(-50, 50))), min(255, max(0, 180 - g // 2 + random.randint(-60, 60))))
            d.rectangle([x, y, x + 5, y + 5], fill=c)


def bubble(d, cx, cy, rx, ry):
    d.ellipse([cx - rx - 4, cy - ry - 4, cx + rx + 4, cy + ry + 4], fill=(0, 0, 0))
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(255, 255, 255))


INK = {}


def ink(d, draws):
    layer = Image.new("L", d.im.size, 0)
    ld = ImageDraw.Draw(layer)
    for xy, s, kw in draws:
        ld.text(xy, s, **{**kw, "fill": 255, **({"stroke_fill": 255} if kw.get("stroke_width") else {})})
    return list(layer.getbbox())


def text_h(d, x, y, s, size, fill=(0, 0, 0), stroke=0, stroke_fill=None):
    f = font(size)
    d.text((x, y), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
    b = d.textbbox((x, y), s, font=f, stroke_width=stroke)
    box = [b[0], b[1], b[2], b[3]]
    INK[tuple(box)] = ink(d, [((x, y), s, {"font": f, "stroke_width": stroke})])
    return box


def text_v(d, x, y, s, size):
    f = font(size)
    boxes = []
    draws = []
    for i, ch in enumerate(s):
        d.text((x, y + i * int(size * 1.05)), ch, font=f, fill=(0, 0, 0))
        boxes.append(d.textbbox((x, y + i * int(size * 1.05)), ch, font=f))
        draws.append(((x, y + i * int(size * 1.05)), ch, {"font": f}))
    box = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
    INK[tuple(box)] = ink(d, draws)
    return box


truth = {}


def save(name, img, blocks, fmt="PNG", **kw):
    img.save(OUT / name, fmt, **kw)
    for b in blocks:
        b["ink"] = INK[tuple(b["box"])]
    truth[name] = {"w": img.width, "h": img.height, "blocks": blocks}


img = Image.new("RGB", (800, 1200), "white")
d = ImageDraw.Draw(img)
art(img, (26, 26, 774, 574))
d.rectangle([20, 20, 780, 580], outline=(0, 0, 0), width=6)
art(img, (26, 606, 774, 1174))
d.rectangle([20, 600, 780, 1180], outline=(0, 0, 0), width=6)
bubble(d, 220, 190, 115, 125)
b1 = text_v(d, 196, 92, "こんにちは", 40)
bubble(d, 560, 420, 175, 80)
b2 = text_h(d, 432, 398, "元気ですか？", 40)
b3 = text_h(d, 470, 70, "ドン", 96, fill=(255, 255, 255), stroke=5, stroke_fill=(0, 0, 0))
bubble(d, 400, 860, 170, 95)
b4 = text_h(d, 290, 838, "ありがとう！", 40)
d.rectangle([40, 1080, 330, 1160], fill=(255, 255, 255), outline=(0, 0, 0), width=4)
b5 = text_h(d, 120, 1096, "翌日", 40)
save("manga.png", img, [
    {"box": b1, "t": "Hello there!"},
    {"box": b2, "t": "How have you been?"},
    {"box": b3, "t": "BOOM"},
    {"box": b4, "t": "Thank you so much!"},
    {"box": b5, "t": "The next day"},
])

img = Image.new("RGB", (600, 3000), "white")
d = ImageDraw.Draw(img)
for y0 in (0, 1150, 2200):
    art(img, (0, y0, 600, y0 + 500))
bubble(d, 300, 300, 200, 90)
s1 = text_h(d, 160, 278, "どこへ行くの？", 40)
bubble(d, 300, 930, 210, 110)
s2 = text_h(d, 170, 905, "ちょっと待って", 40)
bubble(d, 300, 1900, 200, 90)
s3 = text_h(d, 200, 1878, "本当に？", 40)
bubble(d, 300, 2850, 200, 90)
s4 = text_h(d, 180, 2828, "また明日ね", 40)
save("strip.png", img, [
    {"box": s1, "t": "Where are you going?"},
    {"box": s2, "t": "Wait a second"},
    {"box": s3, "t": "Really?"},
    {"box": s4, "t": "See you tomorrow"},
])

img = Image.new("RGB", (900, 600), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 900, 600))
d.rectangle([290, 190, 610, 330], fill=(255, 255, 255), outline=(20, 20, 20), width=5)
g1 = text_h(d, 370, 225, "出口", 64)
save("sign.jpg", img, [{"box": g1, "t": "Exit"}], fmt="JPEG", quality=92)

img = Image.new("RGB", (600, 400), "white")
d = ImageDraw.Draw(img)
art(img, (0, 90, 600, 400))
m1 = text_h(d, 170, 22, "月曜日の朝", 44)
save("meme.png", img, [{"box": m1, "t": "Monday morning"}])

img = Image.new("RGB", (600, 400), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 600, 400))
bubble(d, 300, 200, 180, 90)
h1 = text_h(d, 236, 178, "秘密だよ", 40)
save("hotlink.png", img, [{"box": h1, "t": "It's a secret"}])

for name, word, tr in (("lazy.png", "おはよう", "Good morning"), ("dynamic.png", "さようなら", "Goodbye")):
    img = Image.new("RGB", (600, 450), "white")
    d = ImageDraw.Draw(img)
    art(img, (0, 0, 600, 450))
    bubble(d, 300, 225, 190, 95)
    bx = text_h(d, 300 - 20 * len(word), 203, word, 40)
    save(name, img, [{"box": bx, "t": tr}])

img = Image.new("RGB", (600, 400), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 600, 400))
bubble(d, 190, 130, 150, 80)
p1 = text_h(d, 130, 108, "またね", 40)
save("positioned.png", img, [{"box": p1, "t": "See you"}])

img = Image.new("RGB", (640, 360), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 640, 360))
bubble(d, 160, 110, 130, 70)
l1 = text_h(d, 100, 90, "最初の行", 36)
bubble(d, 470, 260, 140, 70)
l2 = text_h(d, 400, 240, "二番目の行", 36)
save("loop.png", img, [{"box": l1, "t": "First line"}, {"box": l2, "t": "Second line"}])

img = Image.new("RGB", (700, 300), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 700, 300))
bubble(d, 170, 150, 140, 70)
w1 = text_h(d, 100, 130, "はじめの言葉", 32)
bubble(d, 520, 150, 140, 70)
w2 = text_h(d, 450, 130, "つぎの言葉", 32)
save("stubborn.png", img, [{"box": w1, "t": "First words"}, {"box": w2, "t": "Next words"}])

img = Image.new("RGB", (500, 500), "white")
d = ImageDraw.Draw(img)
art(img, (0, 0, 500, 400))
r1 = text_h(d, 150, 425, "答えなし", 40)
save("refuse.png", img, [{"box": r1, "t": "Never shown"}])

(OUT / "pages").mkdir(exist_ok=True)
for n, (word, tr, bx, by) in enumerate((("一枚目", "Page one", 210, 200), ("二枚目", "Page two", 470, 300),
                                         ("三枚目", "Page three", 230, 620), ("四枚目", "Page four", 480, 700)), 1):
    img = Image.new("RGB", (700, 900), "white")
    d = ImageDraw.Draw(img)
    art(img, (0, 0, 700, 900))
    bubble(d, bx, by, 150, 80)
    t = text_h(d, bx - 60, by - 22, word, 40)
    save(f"pages/{n}.png", img, [{"box": t, "t": tr}])

for name, word, tr, bx, by in (("k7q2", "最初の頁", "First leaf", 250, 180), ("m3x9", "次の頁", "Next leaf", 450, 640),
                               ("z5c1", "最後の頁", "Last leaf", 300, 420)):
    img = Image.new("RGB", (700, 900), "white")
    d = ImageDraw.Draw(img)
    art(img, (0, 0, 700, 900))
    bubble(d, bx, by, 150, 80)
    t = text_h(d, bx - 70, by - 22, word, 40)
    save(f"pages/{name}.png", img, [{"box": t, "t": tr}])

for name, word, tr, bx, by in (("b1x", "第一頁", "Book one", 260, 200), ("q7w", "第二頁", "Book two", 440, 360),
                               ("h3n", "第三頁", "Book three", 280, 560), ("t9v", "第四頁", "Book four", 430, 720)):
    img = Image.new("RGB", (700, 900), "white")
    d = ImageDraw.Draw(img)
    art(img, (0, 0, 700, 900))
    bubble(d, bx, by, 150, 80)
    t = text_h(d, bx - 60, by - 22, word, 40)
    save(f"pages/{name}.png", img, [{"box": t, "t": tr}])

Image.new("RGB", (32, 32), (200, 30, 30)).save(OUT / "icon.png")

(OUT / "truth.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
print("fixtures:", ", ".join(truth))
