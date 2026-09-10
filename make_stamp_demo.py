from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
from pathlib import Path

root = Path(r"C:\Users\weimi\Documents\ChatGPT\New project")
base = Image.open(root / "assets" / "stamp-paper-transparent.png").convert("RGBA")
w, h = base.size
panel_h = int(h * 0.43)

image_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
draw = ImageDraw.Draw(image_layer)
for y in range(panel_h):
    t = y / max(1, panel_h - 1)
    draw.line((0, y, w, y), fill=(184 + int(35*t), 204 + int(24*t), 145 + int(38*t), 255))
draw.ellipse((w*0.16, h*0.03, w*0.86, panel_h*1.1), fill=(236, 218, 151, 80))
draw.rectangle((0, panel_h-24, w, panel_h+10), fill=(198, 181, 139, 38))

# Keep every generated layer inside the real postage-stamp silhouette.
stamp_alpha = base.getchannel("A")
image_layer.putalpha(ImageChops.multiply(image_layer.getchannel("A"), stamp_alpha))

composite = Image.alpha_composite(image_layer, base)
print_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
pd = ImageDraw.Draw(print_layer)
try:
    serif = ImageFont.truetype("C:/Windows/Fonts/simfang.ttf", 48)
    small = ImageFont.truetype("C:/Windows/Fonts/simsun.ttc", 25)
    meta = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 18)
except OSError:
    serif = small = meta = ImageFont.load_default()
pd.text((80, int(h*.48)), "在隆冬，我终于知道，", font=serif, fill=(49, 43, 36, 240))
pd.text((80, int(h*.55)), "我身上有一个不可战胜的夏天。", font=serif, fill=(49, 43, 36, 240))
pd.line((80, int(h*.65), 180, int(h*.65)), fill=(39, 35, 30, 220), width=3)
pd.text((80, int(h*.69)), "阿尔贝·加缪", font=small, fill=(63, 55, 46, 230))
pd.text((80, int(h*.735)), "《反与正》", font=small, fill=(63, 55, 46, 185))
pd.text((80, int(h*.83)), "LITERARY POSTCARD  /  1937", font=meta, fill=(108, 98, 84, 210))
print_layer.putalpha(ImageChops.multiply(print_layer.getchannel("A"), stamp_alpha))
composite = Image.alpha_composite(composite, print_layer)

out = root / "assets" / "stamp-layer-demo.png"
composite.save(out)
print(out)
