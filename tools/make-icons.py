from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PINK = (255, 72, 176, 255)
INK = (0, 0, 0, 255)
FONT = ROOT / "fonts" / "comic-neue-700.woff2"


def draw(size: int) -> Image.Image:
    s = 8
    W = size * s
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    lw = max(int(W * 0.07), s)
    box = (lw, lw, W - lw, int(W * 0.78))
    tail = [(int(W * 0.22), int(W * 0.70)), (int(W * 0.44), int(W * 0.70)), (int(W * 0.14), W - lw)]
    d.rounded_rectangle(box, radius=int(W * 0.3), fill=INK)
    d.polygon([(x, y) for x, y in tail], fill=INK)
    inset = (box[0] + lw, box[1] + lw, box[2] - lw, box[3] - lw)
    d.rounded_rectangle(inset, radius=int(W * 0.3) - lw, fill=PINK)
    t2 = [(tail[0][0] + lw, tail[0][1] - lw), (tail[1][0] - lw, tail[1][1] - lw), (tail[2][0] + lw // 2, tail[2][1] - int(lw * 2.2))]
    d.polygon(t2, fill=PINK)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(W * 0.46))
    except OSError:
        font = ImageFont.load_default()
    cx = (inset[0] + inset[2]) / 2
    cy = (inset[1] + inset[3]) / 2
    d.text((cx, cy + W * 0.01), "A", font=font, fill=INK, anchor="mm")
    return im.resize((size, size), Image.LANCZOS)


for n in (16, 32, 48, 128):
    draw(n).save(ROOT / "icons" / f"icon{n}.png")
print("icons written")
