from pathlib import Path
import json
import math
import re
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "assets" / "stamps"
DATA = ROOT / "data" / "quotes.json"
BASE = Image.open(ROOT / "assets" / "stamp-paper-transparent.png").convert("RGBA")
W, H = BASE.size
ALPHA = BASE.getchannel("A")
COLORS = [
    ((178, 203, 139), (235, 208, 149)),
    ((153, 169, 164), (211, 190, 167)),
    ((163, 181, 190), (209, 193, 183)),
    ((184, 160, 141), (220, 202, 178)),
    ((142, 158, 146), (215, 195, 174)),
]


def clipped(layer):
    layer.putalpha(ImageChops.multiply(layer.getchannel("A"), ALPHA))
    return layer


def font(path, size):
    return ImageFont.truetype(path, size)


def wrap_text(draw, text, selected_font, max_width):
    lines, current = [], ""
    for char in text:
        candidate = current + char
        if current and draw.textlength(candidate, font=selected_font) > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def make_art(c1, c2, seed):
    art = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)
    panel_height = int(H * 0.43)
    for y in range(panel_height):
        ratio = y / panel_height
        color = tuple(int(c1[k] * (1 - ratio) + c2[k] * ratio) for k in range(3)) + (255,)
        draw.line((0, y, W, y), fill=color)
    for j in range(5):
        cx = W * (0.18 + ((j * 0.19 + seed * 0.07) % 0.75))
        cy = panel_height * (0.16 + ((j * 0.27 + seed * 0.11) % 0.68))
        radius = 95 + j * 24
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=(246, 233, 202, 28 + j * 7))
    return clipped(art.filter(ImageFilter.GaussianBlur(14)))


def fit_quote(draw, text):
    for size in range(51, 29, -2):
        selected = font("C:/Windows/Fonts/simfang.ttf", size)
        lines = wrap_text(draw, text, selected, W - 200)
        line_height = math.ceil(size * 1.65)
        if len(lines) <= 5 and len(lines) * line_height <= H * 0.34:
            return selected, lines, line_height
    return selected, lines, line_height


quotes = json.loads(DATA.read_text(encoding="utf-8"))
requested_ids = {int(value) for value in sys.argv[1:]}
if requested_ids:
    quotes = [item for item in quotes if item["id"] in requested_ids]
OUT.mkdir(parents=True, exist_ok=True)
author_font = font("C:/Windows/Fonts/simsun.ttc", 35)
meta_font = font("C:/Windows/Fonts/consola.ttf", 19)
detail_font = font("C:/Windows/Fonts/simsun.ttc", 29)

for item in quotes:
    idx = item["id"]
    card = Image.alpha_composite(make_art(*COLORS[(idx - 1) % len(COLORS)], idx), BASE)
    ink = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(ink)
    quote_font, lines, line_height = fit_quote(draw, item["sentence"])
    # 长句上移，给正文末行和分割线预留更充足的呼吸空间。
    y = int(H * (0.41 if len(item["sentence"]) >= 80 else 0.47))
    for line in lines:
        draw.text((100, y), line, font=quote_font, fill=(49, 43, 36, 238))
        y += line_height
    rule_y = min(int(H * 0.79), max(int(H * 0.62), y + (58 if len(item["sentence"]) >= 80 else 28)))
    draw.line((100, rule_y, 200, rule_y), fill=(49, 43, 36, 205), width=3)
    draw.text((100, rule_y + 36), item["author"], font=author_font, fill=(63, 55, 46, 225))
    # 书名严格照工作簿显示，保留用户录入的《书名号》和版本信息。
    book = item["book"]
    draw.text((100, rule_y + 104), book, font=detail_font, fill=(63, 55, 46, 180))
    draw.text((100, int(H * 0.86)), f"LITERARY POSTCARD  /  {idx:03d}", font=meta_font, fill=(108, 98, 84, 205))
    if item["chapter"]:
        draw.text((100, int(H * 0.89)), item["chapter"], font=detail_font, fill=(108, 98, 84, 175))
    card = Image.alpha_composite(card, clipped(ink))
    card.save(OUT / f"stamp-{idx:03d}.png", optimize=True)

print(f"Generated {len(quotes)} stamps from {DATA}")
