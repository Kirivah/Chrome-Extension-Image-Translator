import json
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = Path(__file__).resolve().parent
SERIF = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"
SANS = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"
REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
assert Path(SERIF).exists() and Path(SANS).exists(), "need Noto CJK fonts"
JP, KR, SC = 0, 1, 2


def font(size, serif=True, face=None, lang=JP):
    if face == "latin":
        return ImageFont.truetype(LATIN, size)
    path = REGULAR if face == "regular" else SERIF if serif else SANS
    return ImageFont.truetype(path, size, index=lang)


class Page:
    def __init__(self, w, h, bg=(255, 255, 255), seed=1):
        self.img = Image.new("RGB", (w, h), bg)
        self.d = ImageDraw.Draw(self.img)
        self.labels = Image.new("L", (w, h), 0)
        self.blocks = []
        self.rng = random.Random(seed)

    def panel(self, box, width=3):
        self.d.rectangle(box, outline=(0, 0, 0), width=width)

    def bezier(self, p0, p1, p2, n=24):
        out = []
        for i in range(n + 1):
            t = i / n
            a = (1 - t) ** 2
            b = 2 * (1 - t) * t
            c = t * t
            out.append((a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]))
        return out

    def strands(self, box, n, color, widths=(1, 2, 2, 3), drift=0.35):
        x0, y0, x1, y1 = box
        r = self.rng
        for _ in range(n):
            sx = r.uniform(x0, x1)
            sy = r.uniform(y0, y0 + 0.25 * (y1 - y0))
            ex = min(x1, max(x0, sx + r.uniform(-drift, drift) * (x1 - x0)))
            ey = r.uniform(y0 + 0.55 * (y1 - y0), y1)
            cx = (sx + ex) / 2 + r.uniform(-0.25, 0.25) * (x1 - x0)
            cy = (sy + ey) / 2
            self.d.line(self.bezier((sx, sy), (cx, cy), (ex, ey)), fill=color, width=r.choice(widths))

    def black_hair(self, box):
        x0, y0, x1, y1 = box
        self.d.ellipse((x0, y0, x1, y1 + (y1 - y0) // 3), fill=(18, 18, 18))
        self.strands((x0 + 8, y0 + 10, x1 - 8, y1), 26, (235, 235, 235), widths=(1, 2, 2))
        self.strands((x0, y0, x1, y1), 40, (60, 60, 60), widths=(1, 1, 2))

    def hatching(self, box, spacing=5, angle=35, color=(40, 40, 40), width=1):
        x0, y0, x1, y1 = box
        layer = Image.new("L", self.img.size, 0)
        ld = ImageDraw.Draw(layer)
        diag = int(math.hypot(x1 - x0, y1 - y0)) + 4
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        a = math.radians(angle)
        dx, dy = math.cos(a), math.sin(a)
        for k in range(-diag, diag, spacing):
            px_, py_ = cx - dy * k, cy + dx * k
            ld.line((px_ - dx * diag, py_ - dy * diag, px_ + dx * diag, py_ + dy * diag), fill=255, width=width)
        clip = Image.new("L", self.img.size, 0)
        ImageDraw.Draw(clip).rectangle(box, fill=255)
        layer = Image.composite(layer, Image.new("L", self.img.size, 0), clip)
        self.img.paste(Image.new("RGB", self.img.size, color), (0, 0), layer)

    def screentone(self, box, spacing=5, radius=1.2, color=(70, 70, 70)):
        x0, y0, x1, y1 = box
        for y in range(y0, y1, spacing):
            off = spacing // 2 if ((y - y0) // spacing) % 2 else 0
            for x in range(x0 + off, x1, spacing):
                self.d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)

    def figure(self, cx, top, scale=1.0, hair="strands"):
        s = scale
        d = self.d
        head = (cx - 55 * s, top + 30 * s, cx + 55 * s, top + 160 * s)
        d.ellipse(head, outline=(20, 20, 20), width=2, fill=(250, 246, 240))
        d.arc((cx - 30 * s, top + 85 * s, cx - 8 * s, top + 105 * s), 200, 340, fill=(20, 20, 20), width=3)
        d.arc((cx + 8 * s, top + 85 * s, cx + 30 * s, top + 105 * s), 200, 340, fill=(20, 20, 20), width=3)
        d.line((cx - 8 * s, top + 130 * s, cx + 6 * s, top + 132 * s), fill=(30, 30, 30), width=2)
        hb = (int(cx - 75 * s), int(top), int(cx + 75 * s), int(top + 95 * s))
        if hair == "black":
            self.black_hair(hb)
        else:
            self.strands(hb, 150, (30, 30, 30))
        body = [(cx - 120 * s, top + 330 * s), (cx - 70 * s, top + 175 * s), (cx + 70 * s, top + 175 * s), (cx + 120 * s, top + 330 * s)]
        d.polygon(body, outline=(15, 15, 15), fill=(245, 245, 245))
        for k in range(6):
            fx = cx - 60 * s + k * 24 * s
            d.line((fx, top + 190 * s, fx + 10 * s, top + 320 * s), fill=(40, 40, 40), width=2)

    def blob_fill(self, box, color=(12, 12, 12)):
        self.d.rounded_rectangle(box, radius=18, fill=color)
        x0, y0, x1, y1 = box
        for k in range(5):
            y = y0 + 12 + k * (y1 - y0 - 24) // 5
            self.d.line((x0 + 10, y, x0 + 40 + k * 7, y + 18), fill=(230, 230, 230), width=2)

    def stained_glass(self, box, cells=26):
        x0, y0, x1, y1 = box
        r = self.rng
        pts = [(r.uniform(x0, x1), r.uniform(y0, y1)) for _ in range(cells)]
        tile = Image.new("RGB", (x1 - x0, y1 - y0))
        tp = tile.load()
        cols = [(r.randint(60, 230), r.randint(60, 220), r.randint(80, 240)) for _ in pts]
        for yy in range(y1 - y0):
            for xx in range(x1 - x0):
                X, Y = xx + x0, yy + y0
                best, second, bi = 1e18, 1e18, 0
                for i, (px_, py_) in enumerate(pts):
                    dd = (px_ - X) ** 2 + (py_ - Y) ** 2
                    if dd < best:
                        second, best, bi = best, dd, i
                    elif dd < second:
                        second = dd
                c = cols[bi]
                if math.sqrt(second) - math.sqrt(best) < 2.2:
                    tp[xx, yy] = (40, 36, 44)
                else:
                    shade = 0.85 + 0.15 * math.sin((X + Y) / 23.0)
                    tp[xx, yy] = tuple(int(v * shade) for v in c)
        self.img.paste(tile.filter(ImageFilter.GaussianBlur(0.6)), (x0, y0))

    def gradient(self, box, top, bottom):
        x0, y0, x1, y1 = box
        for y in range(y0, y1):
            t = (y - y0) / max(1, y1 - y0 - 1)
            c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
            self.d.line((x0, y, x1 - 1, y), fill=c)

    def noise(self, box, block=8, lo=(40, 20, 90), hi=(150, 110, 220)):
        x0, y0, x1, y1 = box
        r = self.rng
        for y in range(y0, y1, block):
            for x in range(x0, x1, block):
                c = tuple(r.randint(lo[i], hi[i]) for i in range(3))
                self.d.rectangle((x, y, min(x1, x + block) - 1, min(y1, y + block) - 1), fill=c)

    def round_box(self, box, radius=24, fill=(255, 255, 255), outline=(0, 0, 0), width=2):
        self.d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

    def bubble(self, box, tail=None, width=3):
        self.d.ellipse(box, fill=(255, 255, 255), outline=(0, 0, 0), width=width)
        if tail:
            self.d.polygon(tail, fill=(255, 255, 255), outline=(0, 0, 0))
            x0, y0, x1, y1 = box
            self.d.ellipse((x0 + width, y0 + width, x1 - width, y1 - width), fill=(255, 255, 255))

    def _glyph(self, xy, ch, f, fill, stroke, stroke_fill, label):
        self.d.text(xy, ch, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        m = Image.new("L", self.img.size, 0)
        ImageDraw.Draw(m).text(xy, ch, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
        self.labels.paste(label, (0, 0), m.point(lambda v: 255 if v > 40 else 0))

    def vertical(self, x_right, y, columns, size, *, kind, chars, serif=True, fill=(0, 0, 0), stroke=0,
                 stroke_fill=(255, 255, 255), ruby=None, gap=0.45, polarity="dark", face=None):
        label = len(self.blocks) + 1
        f = font(size, serif, face)
        step = int(size * 1.06)
        for k, col in enumerate(columns):
            x = x_right - (k + 1) * size - int(k * gap * size)
            for i, ch in enumerate(col):
                cy = y + i * step
                if ch == "ー":
                    self.d.line((x + size // 2, cy + 4, x + size // 2, cy + size - 4), fill=fill, width=max(2, size // 9))
                    m = Image.new("L", self.img.size, 0)
                    ImageDraw.Draw(m).line((x + size // 2, cy + 4, x + size // 2, cy + size - 4), fill=255, width=max(2, size // 9) + 2 * stroke)
                    self.labels.paste(label, (0, 0), m)
                    continue
                self._glyph((x, cy), ch, f, fill, stroke, stroke_fill, label)
                if ruby and (k, i) in ruby:
                    rs = max(9, int(size * 0.42))
                    rf = font(rs, serif)
                    for j, rch in enumerate(ruby[(k, i)]):
                        self._glyph((x + size + 2, cy + j * rs - 1), rch, rf, fill, 0, stroke_fill, label)
        self._record(label, kind, polarity, True, size, chars)

    def horizontal(self, x, y, lines, size, *, kind, chars, serif=False, fill=(0, 0, 0), stroke=0,
                   stroke_fill=(255, 255, 255), polarity="dark", angle=0, face=None, lang=JP, center=None):
        label = len(self.blocks) + 1
        f = font(size, serif, face, lang)
        if angle:
            w = int(size * max(len(t) for t in lines) * 1.3) + 4 * stroke + 20
            h = int(size * 1.3 * len(lines)) + 4 * stroke + 20
            layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            mask = Image.new("L", (w, h), 0)
            md = ImageDraw.Draw(mask)
            for i, t in enumerate(lines):
                p = (10 + stroke, 10 + stroke + int(i * size * 1.25))
                ld.text(p, t, font=f, fill=fill + (255,), stroke_width=stroke, stroke_fill=stroke_fill + (255,))
                md.text(p, t, font=f, fill=255, stroke_width=stroke, stroke_fill=255)
            layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True)
            mask = mask.rotate(angle, resample=Image.BICUBIC, expand=True)
            self.img.paste(layer, (x, y), layer)
            self.labels.paste(label, (x, y), mask.point(lambda v: 255 if v > 40 else 0))
        else:
            for i, t in enumerate(lines):
                lx = x if center is None else int(center - self.d.textlength(t, font=f) / 2)
                self._glyph((lx, y + int(i * size * 1.25)), t, f, fill, stroke, stroke_fill, label)
        self._record(label, kind, polarity, False, size, chars)

    def _record(self, label, kind, polarity, vertical, size, chars):
        self.blocks.append({"id": label, "kind": kind, "polarity": polarity, "vertical": vertical,
                            "size": size, "chars": chars})

    def group(self, name):
        self.blocks[-1]["group"] = name

    def tag(self, **kv):
        self.blocks[-1].update(kv)

    def save(self, name):
        self.img.save(OUT / f"{name}.png", optimize=True)
        self.labels.save(OUT / f"{name}.labels.png", optimize=True)
        lp = self.labels.load()
        W, H = self.labels.size
        boxes = {}
        for y in range(H):
            for x in range(W):
                v = lp[x, y]
                if v:
                    b = boxes.setdefault(v, [x, y, x + 1, y + 1])
                    b[0] = min(b[0], x); b[1] = min(b[1], y); b[2] = max(b[2], x + 1); b[3] = max(b[3], y + 1)
        for b in self.blocks:
            b["box"] = boxes[b["id"]]
        return {"w": W, "h": H, "blocks": self.blocks}


def page1():
    p = Page(800, 1200, seed=11)
    p.panel((20, 20, 780, 470))
    p.panel((20, 490, 390, 1180))
    p.panel((410, 490, 780, 1180))
    p.hatching((24, 24, 776, 200), spacing=6, angle=30, color=(90, 90, 90))
    p.figure(250, 60, 1.05, hair="strands")
    p.bubble((520, 40, 760, 330), tail=[(560, 300), (500, 360), (600, 318)])
    p.vertical(712, 75, ["なんだ…これ？", "俺はついさっき", "まで職場に…"], 26, kind="bubble", chars=58,
               ruby={(1, 0): "おれ"})
    p.vertical(120, 230, ["地震だ…", "そうだ"], 22, kind="open", chars=60)
    p.vertical(470, 40, ["誰だこの人"], 24, kind="art", chars=40, stroke=4)
    p.screentone((24, 494, 386, 1176), spacing=6, radius=1.3)
    p.figure(200, 560, 0.95, hair="black")
    p.d.rectangle((40, 1040, 360, 1150), fill=(10, 10, 10))
    p.horizontal(60, 1062, ["そして全てが", "変わった"], 30, kind="caption", chars=34, fill=(255, 255, 255),
                 polarity="light", serif=False)
    p.horizontal(220, 860, ["ドン"], 74, kind="sfx", chars=6, stroke=6, angle=12, serif=False)
    p.hatching((414, 494, 776, 1176), spacing=4, angle=-40, color=(60, 60, 60))
    p.blob_fill((600, 820, 760, 1160))
    p.bubble((430, 520, 690, 800), tail=[(600, 780), (650, 860), (640, 770)])
    p.vertical(640, 560, ["とうとう王女殿下も", "決断なされた", "のですね…"], 24, kind="bubble", chars=62)
    p.vertical(735, 540, ["小声"], 15, kind="aside", chars=12, stroke=3)
    p.vertical(728, 860, ["静かに"], 26, kind="art-light", chars=14, fill=(255, 255, 255), stroke=3,
               stroke_fill=(0, 0, 0), polarity="light", serif=False)
    return p.save("manga-1")


def page2():
    p = Page(860, 1220, bg=(250, 250, 250), seed=23)
    p.gradient((0, 0, 860, 520), (210, 196, 180), (150, 140, 130))
    p.panel((10, 10, 850, 520))
    p.panel((10, 540, 300, 1210))
    p.panel((320, 540, 850, 1210))
    p.stained_glass((14, 544, 296, 1206), cells=30)
    p.gradient((324, 544, 846, 1206), (150, 20, 30), (90, 10, 20))
    p.strands((420, 640, 760, 900), 120, (70, 0, 10), widths=(2, 3, 4))
    p.figure(600, 760, 1.0, hair="black")
    p.d.rectangle((700, 30, 830, 300), fill=(255, 255, 255))
    p.vertical(805, 50, ["イルムガルド", "大陸を統べる"], 30, kind="open", chars=31, serif=False)
    p.horizontal(60, 60, ["五つの王国"], 40, kind="art", chars=16, stroke=5, serif=False)
    p.horizontal(380, 330, ["キラッ"], 46, kind="sfx", chars=8, stroke=5, angle=-15, serif=False)
    p.vertical(285, 600, ["「五つの王家の", "ルーツを辿れば"], 26, kind="art", chars=44, stroke=4)
    p.vertical(190, 860, ["それは全て一", "人の男に", "辿り着く"], 26, kind="art", chars=34, stroke=4)
    p.vertical(820, 980, ["ドスッ"], 54, kind="sfx", chars=6, fill=(255, 255, 255), stroke=5,
               stroke_fill=(20, 0, 0), polarity="light", serif=False)
    p.bubble((340, 940, 560, 1190))
    p.vertical(505, 980, ["新連載！", "始まり"], 28, kind="bubble", chars=22)
    return p.save("manga-2")


def page3():
    p = Page(820, 1180, seed=37)
    p.panel((16, 16, 804, 1164))
    cx, cy = 410, 600
    r = p.rng
    for k in range(240):
        a = r.uniform(0, 2 * math.pi)
        r0 = r.uniform(180, 260)
        p.d.line((cx + math.cos(a) * r0, cy + math.sin(a) * r0, cx + math.cos(a) * 900, cy + math.sin(a) * 900),
                 fill=(30, 30, 30), width=r.choice([1, 1, 2]))
    p.d.rectangle((16, 16, 804, 60), fill=(255, 255, 255))
    p.screentone((20, 900, 800, 1160), spacing=5, radius=1.6, color=(40, 40, 40))
    p.figure(410, 420, 1.1, hair="strands")
    p.bubble((40, 80, 280, 360))
    p.vertical(232, 120, ["待て！", "行くな！"], 34, kind="bubble", chars=22)
    p.bubble((560, 90, 790, 400))
    p.vertical(742, 130, ["俺は", "まだ", "戦える"], 32, kind="bubble", chars=26, ruby={(2, 0): "たたか"})
    p.vertical(150, 520, ["うおおお"], 44, kind="sfx", chars=8, stroke=6, serif=False)
    p.horizontal(470, 760, ["ゴゴゴ"], 64, kind="sfx", chars=6, stroke=6, angle=-8, serif=False)
    p.d.rectangle((520, 940, 780, 1130), fill=(255, 255, 255), outline=(0, 0, 0), width=2)
    p.vertical(750, 960, ["その日", "全てが", "始まった"], 28, kind="caption", chars=30)
    return p.save("manga-3")


def page4():
    p = Page(860, 1320, bg=(255, 255, 255), seed=41)
    p.gradient((0, 0, 860, 430), (150, 196, 236), (236, 244, 252))
    p.noise((0, 450, 860, 860))
    p.gradient((0, 880, 860, 1320), (24, 30, 64), (10, 12, 30))
    p.horizontal(60, 40, ["그날 아침"], 34, kind="open", chars=14, lang=KR)
    p.round_box((420, 120, 820, 300), radius=40)
    p.horizontal(0, 160, ["어디 가는 거야?", "잠깐만 기다려"], 30, kind="bubble", chars=34, face="regular", lang=KR, center=620)
    p.d.rectangle((40, 250, 360, 400), fill=(205, 205, 205))
    p.horizontal(60, 275, ["这一天，", "一切都改变了"], 30, kind="caption", chars=30, lang=SC)
    p.horizontal(120, 520, ["쾅쾅"], 110, kind="sfx", chars=8, fill=(255, 255, 255), stroke=9,
                 stroke_fill=(0, 0, 0), polarity="light", lang=KR)
    p.d.ellipse((540, 600, 820, 800), fill=(236, 236, 236), outline=(90, 90, 90), width=2)
    p.horizontal(0, 665, ["괜찮을까…"], 26, kind="bubble", chars=16, face="regular", lang=KR, center=680)
    p.horizontal(80, 960, ["모든 것이", "시작되었다"], 36, kind="caption", chars=30, fill=(245, 245, 245),
                 polarity="light", lang=KR)
    p.d.rectangle((470, 1120, 820, 1260), fill=(250, 250, 250))
    p.horizontal(495, 1150, ["那个人是谁？"], 34, kind="caption", chars=16, serif=True, lang=SC)
    return p.save("manga-4")


def page5():
    p = Page(820, 1240, seed=53)
    p.panel((16, 16, 804, 600))
    p.panel((16, 620, 400, 1224))
    p.panel((420, 620, 804, 1224))
    p.screentone((20, 20, 800, 596), spacing=6, radius=1.0, color=(110, 110, 110))
    p.figure(560, 120, 1.0, hair="strands")
    p.bubble((40, 40, 300, 330))
    p.vertical(240, 80, ["ちょっと", "待ってよ…", "まだ話は"], 26, kind="bubble", chars=40, face="regular")
    p.vertical(380, 60, ["その時", "だった"], 30, kind="art", chars=26, serif=True)
    p.bubble((620, 380, 790, 580))
    p.vertical(745, 410, ["えっ", "なに？"], 16, kind="bubble", chars=14, face="regular")
    p.bubble((40, 660, 380, 860))
    p.horizontal(0, 705, ["WHAT ARE", "YOU DOING?!"], 30, kind="bubble", chars=22, face="latin", center=210)
    p.hatching((424, 624, 800, 1220), spacing=5, angle=55, color=(70, 70, 70))
    p.horizontal(440, 700, ["バンッ"], 96, kind="sfx", chars=6, fill=(255, 255, 255), stroke=5,
                 stroke_fill=(0, 0, 0), polarity="light", angle=10)
    p.bubble((560, 900, 790, 1200))
    p.vertical(712, 935, ["すっごーい！", "やったぁ"], 30, kind="bubble", chars=26)
    p.blob_fill((30, 900, 390, 1210), color=(20, 20, 20))
    p.d.rectangle((50, 1100, 370, 1190), fill=(0, 0, 0), outline=(255, 255, 255), width=2)
    p.horizontal(70, 1120, ["三年後――"], 36, kind="caption", chars=16, fill=(255, 255, 255),
                 polarity="light", face="regular")
    return p.save("manga-5")


def page6():
    p = Page(800, 1200, seed=61)
    p.panel((20, 20, 780, 560))
    p.panel((20, 580, 390, 1180))
    p.panel((410, 580, 780, 1180))
    p.screentone((24, 24, 776, 556), spacing=6, radius=1.2, color=(90, 90, 90))
    p.figure(400, 250, 0.9, hair="strands")
    p.bubble((450, 40, 770, 440), tail=[(520, 400), (470, 470), (560, 420)])
    p.vertical(712, 90, ["なんだよ", "これ…"], 28, kind="bubble", chars=26)
    p.group("A")
    p.vertical(615, 150, ["まさか", "夢じゃ", "ないよな"], 28, kind="bubble", chars=34, ruby={(1, 0): "ゆめ"})
    p.group("A")
    p.bubble((95, 45, 305, 405))
    p.vertical(255, 95, ["はい"], 28, kind="bubble", chars=4)
    p.group("B")
    p.vertical(212, 150, ["それなんですが", "私……"], 28, kind="bubble", chars=26)
    p.group("B")
    p.hatching((24, 584, 386, 1176), spacing=5, angle=40, color=(70, 70, 70))
    p.d.polygon([(200, 620), (370, 620), (370, 1000), (60, 1000), (60, 800), (200, 800)],
                fill=(255, 255, 255), outline=(0, 0, 0))
    p.d.line([(200, 620), (370, 620), (370, 1000), (60, 1000), (60, 800), (200, 800), (200, 620)], fill=(0, 0, 0), width=3)
    p.vertical(350, 640, ["通常であれば", "忌み嫌われる"], 26, kind="caption", chars=40)
    p.group("C")
    p.vertical(185, 820, ["嬉々として", "求める者達"], 26, kind="caption", chars=36)
    p.group("C")
    p.bubble((430, 610, 610, 900))
    p.bubble((600, 640, 770, 930))
    p.vertical(560, 650, ["行くぞ", "みんな"], 28, kind="bubble", chars=16)
    p.vertical(722, 690, ["待って", "くれ"], 28, kind="bubble", chars=14)
    p.vertical(740, 960, ["その時"], 26, kind="open", chars=10)
    p.vertical(520, 1010, ["誰も", "知らなかった"], 26, kind="open", chars=24)
    return p.save("manga-6")


def page7():
    p = Page(960, 720, bg=(150, 200, 235), seed=71)
    r = p.rng
    p.gradient((0, 0, 960, 330), (95, 170, 230), (190, 225, 245))
    p.d.rectangle((300, 250, 760, 560), fill=(222, 210, 180))
    p.d.polygon([(280, 260), (530, 170), (780, 260)], fill=(70, 120, 110))
    for i in range(18):
        p.d.line((290 + i * 27, 258, 530, 172), fill=(50, 90, 85), width=2)
    for wx in range(330, 740, 95):
        for wy in (300, 420):
            p.d.rectangle((wx, wy, wx + 55, wy + 70), fill=(150, 172, 190), outline=(110, 100, 90), width=3)
            p.d.line((wx + 8, wy + 60, wx + 40, wy + 8), fill=(205, 220, 230), width=5)
            p.d.line((wx + 27, wy, wx + 27, wy + 70), fill=(110, 100, 90), width=2)
    p.d.rectangle((0, 560, 960, 720), fill=(120, 125, 135))
    p.d.rectangle((0, 520, 960, 575), fill=(175, 175, 170))
    for bx in range(0, 960, 48):
        p.d.line((bx, 520, bx, 575), fill=(130, 130, 125), width=2)
    for (cx, cy, rw, rh) in ((880, 260, 130, 290), (95, 330, 140, 260), (560, 500, 110, 70)):
        p.d.ellipse((cx - rw, cy - rh, cx + rw, cy + rh), fill=(28, 62, 30))
        for _ in range(int(rw * rh / 12)):
            a = r.uniform(0, 2 * math.pi); d = math.sqrt(r.random())
            x = cx + d * rw * math.cos(a); y = cy + d * rh * math.sin(a)
            g = r.randint(55, 175)
            c = (int(g * 0.4), g, int(g * 0.35))
            k = r.randint(3, 8)
            p.d.ellipse((x - k, y - k * 0.6, x + k, y + k * 0.6), fill=c)
    p.d.rectangle((250, 0, 268, 600), fill=(150, 150, 150))
    for k in range(5):
        y0 = 40 + k * 22
        p.d.line(p.bezier((0, y0), (480, y0 + 60), (960, y0 + 10)), fill=(35, 35, 40), width=2)
    pink = (226, 52, 140)
    white = (255, 255, 255)
    p.vertical(930, 30, ["それでコイツは…", "うわ…出たよ…田中真紘…"], 34, kind="edged", chars=44,
               serif=False, fill=pink, stroke=6, stroke_fill=white, gap=0.5)
    p.vertical(700, 40, ["チビのコミュ障の陰キャで、", "いつもオドオドして…"], 34, kind="edged", chars=80,
               serif=False, fill=pink, stroke=6, stroke_fill=white, gap=0.5)
    p.vertical(215, 40, ["いつもヘラヘラしてて", "見てるだけで不愉快だわ…"], 34, kind="edged", chars=60,
               serif=False, fill=pink, stroke=6, stroke_fill=white, gap=0.5)
    return p.save("cg-1")


def page8():
    p = Page(800, 1000, seed=81)
    p.round_box((40, 40, 420, 470), radius=14, width=3)
    p.horizontal(150, 48, ["ステータス"], 26, kind="field", chars=6)
    p.tag(text="ステータス")
    p.horizontal(70, 110, ["職業"], 26, kind="field", chars=10)
    p.tag(text="職業")
    p.horizontal(150, 110, ["剣士"], 26, kind="field", chars=9)
    p.tag(text="剣士")
    rows = [("攻撃", "12", "防御", "8"), ("魔力", "5", "速さ", "20"), ("器用", "15", "幸運", "3")]
    for k, row in enumerate(rows):
        y = (170, 250, 290)[k]
        for (x, t) in zip((70, 150, 230, 320), row):
            p.horizontal(x, y, [t], 26, kind="field", chars=8 if not t.isdigit() else 2)
            p.tag(text=t, value=t.isdigit())
    p.horizontal(70, 210, ["スタミナ"], 26, kind="field", chars=7)
    p.tag(text="スタミナ")
    p.horizontal(70 + 4 * 26 + 11, 210, ["40"], 26, kind="field", chars=2)
    p.tag(text="40", value=True)
    p.horizontal(150, 410, ["500ゴールド"], 26, kind="field", chars=9)
    p.tag(text="500ゴールド")
    p.d.rectangle((470, 40, 770, 420), fill=(255, 255, 255), outline=(0, 0, 0), width=3)
    p.vertical(750, 62, ["見知らぬ場所で", "目を覚ました時"], 24, kind="caption", chars=40)
    p.tag(text="見知らぬ場所で目を覚ました時")
    p.vertical(666, 62, ["全ては", "もう始まっていた"], 24, kind="caption", chars=36)
    p.tag(text="全てはもう始まっていた")
    p.hatching((40, 500, 300, 800), spacing=5, angle=40, color=(70, 70, 70))
    p.vertical(250, 520, ["ドドン"], 64, kind="sfx", chars=6, fill=(255, 255, 255), stroke=5,
               stroke_fill=(0, 0, 0), polarity="light", serif=False)
    p.tag(text="ドドン")
    p.bubble((440, 470, 780, 730))
    p.vertical(712, 560, ["えっ…"], 26, kind="bubble", chars=8)
    p.tag(text="えっ…")
    p.vertical(640, 520, ["ここは", "どこなんだ", "一体"], 26, kind="bubble", chars=30)
    p.tag(text="ここは どこなんだ 一体")
    p.round_box((330, 850, 770, 985), radius=40)
    p.horizontal(0, 878, ["そうだね", "もう行こうか"], 26, kind="bubble", chars=24, center=550)
    p.tag(text="そうだね もう行こうか")
    return p.save("manga-8")


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["texts"]:
        (OUT / "texts.json").write_text(json.dumps({"manga-8.png": page8()}, indent=1, ensure_ascii=False))
        print("manga-8.png written")
        sys.exit(0)
    if sys.argv[1:] == ["cg"]:
        (OUT / "cg.json").write_text(json.dumps({"cg-1.png": page7()}, indent=1, ensure_ascii=False))
        print("cg-1.png written")
        sys.exit(0)
    if sys.argv[1:] == ["bubbles"]:
        (OUT / "bubbles.json").write_text(json.dumps({"manga-6.png": page6()}, indent=1, ensure_ascii=False))
        print("manga-6.png written")
        sys.exit(0)
    truth = {"manga-1.png": page1(), "manga-2.png": page2(), "manga-3.png": page3(),
             "manga-4.png": page4(), "manga-5.png": page5()}
    (OUT / "manga.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
    for name, t in truth.items():
        print(name, len(t["blocks"]), "blocks")
