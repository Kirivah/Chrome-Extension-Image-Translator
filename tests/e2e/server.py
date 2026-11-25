import base64
import io
import json
import math
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
WWW = HERE / "www"
TRUTH = json.loads((WWW / "truth.json").read_text())
SITE_PORT, CDN_PORT = 8701, 8702
SPECIAL = ("loop.png", "stubborn.png", "refuse.png")
JITTER = True
LOG = {"requests": 0, "images": 0, "batches": [], "keys": set(), "models": set(), "segments": [],
       "special": {n: [] for n in SPECIAL},
       "byModel": {}, "gc": None, "keyTests": 0,
       "pages": [],
       "book": []}
RETIRED = {"gemini-2.5-flash-lite": "This model models/gemini-2.5-flash-lite is no longer available to new users. "
           "Please update your code to use models/gemini-3.5-flash-lite for the latest features and improvements. "
           "We recommend you to use the Interactions API (https://ai.google.dev/gemini-api/docs/get-started)"}
LOCK = threading.Lock()


def round_js(x):
    return math.floor(x + 0.5)


def plan_segments(W, H):
    tall = H > W * 2.2
    wide = W > H * 3
    if not tall and not wide:
        return [(0, 0, W, H)]
    long_, short = (H, W) if tall else (W, H)
    seg = round_js(short * (1.6 if tall else 2))
    ov = round_js(seg * 0.2)
    count = math.ceil((long_ - ov) / (seg - ov))
    if count > 24:
        seg = math.ceil(long_ / 24 * 1.25)
        ov = round_js(seg * 0.2)
        count = math.ceil((long_ - ov) / (seg - ov))
    stride = (long_ - seg) / (count - 1) if count > 1 else 0
    out = []
    for i in range(count):
        a = round_js(i * stride)
        ln = min(seg, long_ - a)
        out.append((0, a, W, ln) if tall else (a, 0, ln, H))
    return out


def thumb(img):
    small = img.convert("L").resize((24, 24), Image.BILINEAR)
    flat = getattr(small, "get_flattened_data", None)
    return list(flat() if flat else small.getdata())


SIGS = []
for name, t in TRUTH.items():
    full = Image.open(WWW / name).convert("RGB")
    for (x, y, w, h) in plan_segments(t["w"], t["h"]):
        crop = full.crop((x, y, x + w, y + h))
        SIGS.append((name, (x, y, w, h), w / h, thumb(crop)))


def identify(img):
    th = thumb(img)
    asp = img.width / img.height
    best = None
    for name, rect, a, sig in SIGS:
        if abs(math.log(asp / a)) > 0.08:
            continue
        mse = sum((p - q) ** 2 for p, q in zip(th, sig)) / len(th)
        if best is None or mse < best[0]:
            best = (mse, name, rect)
    return best


def jitter(name, k, box):
    import hashlib
    x0, y0, x1, y1 = box
    hv = hashlib.sha256(f"{name}#{k}".encode()).digest()
    f = [b / 255 - 0.5 for b in hv[:4]]
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2 + 0.8 * f[0] * w, (y0 + y1) / 2 + 0.8 * f[1] * h
    sw, sh = w * (1 + 0.4 * f[2]), h * (1 + 0.4 * f[3])
    return [round(cx - sw / 2), round(cy - sh / 2), round(cx + sw / 2), round(cy + sh / 2)]


def blocks_for(name, rect):
    x, y, w, h = rect
    out = []
    for k, b in enumerate(TRUTH[name]["blocks"]):
        x0, y0, x1, y1 = jitter(name, k, b["ink"]) if JITTER else b["box"]
        cx0, cy0, cx1, cy1 = max(x0, x), max(y0, y), min(x1, x + w), min(y1, y + h)
        if cx1 - cx0 < 4 or cy1 - cy0 < 4:
            continue
        n = lambda v, o, s: max(0, min(1000, round((v - o) / s * 1000)))
        out.append({"box_2d": [n(cy0, y, h), n(cx0, x, w), n(cy1, y, h), n(cx1, x, w)], "translation": b["t"]})
    return out


class Site(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WWW), **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__log":
            with LOCK:
                body = json.dumps({**LOG, "keys": sorted(LOG["keys"]), "models": sorted(LOG["models"])}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/v1beta/models/"):
            key = self.headers.get("x-goog-api-key", "")
            if not key.startswith("AIza"):
                return self._json(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}})
            return self._json(200, {"name": "models/" + self.path.rsplit("/", 1)[-1]})
        if self.path.startswith("/book.html"):
            return self._book()
        if self.path.split("?")[0] in ("/", "/index.html", "/fail.html", "/scroll.html", "/reader.html", "/reader2.html"):
            self.path = self.path.split("?")[0]
            body = (HERE / ("index.html" if self.path == "/" else self.path[1:])).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def _book(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        try:
            n = max(1, min(4, int(q.get("page", ["1"])[0])))
        except ValueError:
            n = 1
        with LOCK:
            LOG["book"].append(n)
        files = {1: "b1x", 2: "q7w", 3: "h3n", 4: "t9v"}
        body = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Book, page {n}</title>'
                '<link rel="icon" href="data:,"><style>body{margin:0;background:#111}main{padding:10px}'
                'img{display:block;width:560px;height:720px}</style></head><body><main id="reader">'
                f'<a href="/book.html?page={min(4, n + 1)}"><img class="page-img" src="http://127.0.0.1:{CDN_PORT}/pages/{files[n]}.png" alt="page {n}"></a>'
                '</main></body></html>').encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        req = json.loads(self.rfile.read(n))
        key = self.headers.get("x-goog-api-key", "")
        model = self.path.split("/models/")[-1].split(":")[0]
        if not key.startswith("AIza"):
            return self._json(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}})
        if model in RETIRED:
            with LOCK:
                if ":streamGenerateContent" in self.path:
                    LOG["byModel"][model] = LOG["byModel"].get(model, 0) + 1
                else:
                    LOG["keyTests"] += 1
            return self._json(404, {"error": {"code": 404, "message": RETIRED[model], "status": "NOT_FOUND"}})
        if self.path.endswith(":generateContent"):
            with LOCK:
                LOG["keyTests"] += 1
            return self._json(200, {"candidates": [{"content": {"parts": [{"text": "OK"}], "role": "model"}, "finishReason": "STOP"}],
                                    "usageMetadata": {"promptTokenCount": 6, "candidatesTokenCount": 1}})
        if ":streamGenerateContent" not in self.path:
            return self._json(404, {"error": {"code": 404, "message": "not found"}})
        parts = req["contents"][0]["parts"]
        imgs = [Image.open(io.BytesIO(base64.b64decode(p["inlineData"]["data"]))) for p in parts if "inlineData" in p]
        batch = len(imgs)
        temperature = req.get("generationConfig", {}).get("temperature")
        out = []
        names = []
        for i, im in enumerate(imgs):
            hit = identify(im)
            if not hit or hit[0] > 900:
                continue
            _, name, rect = hit
            names.append(name)
            with LOCK:
                LOG["segments"].append([name, rect[1], im.width, im.height])
            for b in blocks_for(name, rect):
                if batch > 1:
                    b = {"image": i, **b}
                out.append(b)
        attempt = 0
        with LOCK:
            LOG["requests"] += 1
            LOG["images"] += batch
            LOG["batches"].append(batch)
            LOG["keys"].add(key[-4:])
            LOG["models"].add(model)
            LOG["byModel"][model] = LOG["byModel"].get(model, 0) + 1
            if batch == 1 and names and names[0] in SPECIAL:
                attempt = len(LOG["special"][names[0]])
                LOG["special"][names[0]].append(temperature)
            else:
                LOG["gc"] = req.get("generationConfig")
        usage = {"promptTokenCount": 1548 * batch + 300}
        finish = "STOP"
        text = json.dumps({"blocks": out}, ensure_ascii=False)
        if any(n in SPECIAL for n in names):
            if batch > 1:
                text, finish = text[: len(text) // 2], "MAX_TOKENS"
            elif names[0] == "refuse.png":
                text, finish = "", "OTHER"
            elif names[0] == "stubborn.png" or attempt == 0:
                first = json.dumps(out[0], ensure_ascii=False)
                stuck = json.dumps(out[1], ensure_ascii=False).split('"translation": "')[0]
                text, finish = '{"blocks": [' + first + ", " + stuck + '"translation": "' + "ド" * 3000, "MAX_TOKENS"
        usage["candidatesTokenCount"] = len(text) // 3
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            time.sleep(0.25)
            for i in range(0, len(text), 24):
                chunk = {"candidates": [{"content": {"parts": [{"text": text[i:i + 24]}], "role": "model"}}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\r\n\r\n".encode())
                self.wfile.flush()
                time.sleep(0.01)
            final = {"candidates": [{"content": {"parts": [{"text": ""}]}, "finishReason": finish}], "usageMetadata": usage}
            self.wfile.write(f"data: {json.dumps(final)}\r\n\r\n".encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


class Cdn(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WWW), **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/pages/"):
            with LOCK:
                LOG["pages"].append(self.path)
        if self.path.startswith("/hot/"):
            ref = self.headers.get("Referer", "")
            if not ref.startswith(f"http://127.0.0.1:{SITE_PORT}"):
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b"hotlinking not allowed")
                return
            self.path = self.path[len("/hot"):]
        return super().do_GET()


def serve(port, handler):
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    threading.Thread(target=serve, args=(CDN_PORT, Cdn), daemon=True).start()
    print(f"site :{SITE_PORT}  cdn :{CDN_PORT}  signatures: {len(SIGS)}", flush=True)
    try:
        serve(SITE_PORT, Site)
    except KeyboardInterrupt:
        sys.exit(0)
