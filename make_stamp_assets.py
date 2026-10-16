from PIL import Image, ImageFilter, ImageOps
from pathlib import Path
import argparse

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description="从原始纸张图片生成邮票模板。")
parser.add_argument("source", nargs="?", type=Path, default=ROOT / "assets" / "stamp-paper.png")
source = parser.parse_args().source
out = ROOT / "assets"
out.mkdir(exist_ok=True)
image = Image.open(source).convert("RGBA")
gray = ImageOps.grayscale(image)
mask = gray.point(lambda value: 255 if value > 48 else 0).filter(ImageFilter.GaussianBlur(0.7))
transparent = image.copy()
transparent.putalpha(mask)
transparent.save(out / "stamp-paper-transparent.png")
mask.save(out / "stamp-mask.png")
image.save(out / "stamp-paper-original.png")
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1536">
  <defs><mask id="stamp"><image href="stamp-mask.png" width="1024" height="1536"/></mask></defs>
  <g mask="url(#stamp)"><image href="stamp-paper-original.png" width="1024" height="1536" preserveAspectRatio="none"/></g>
</svg>'''
(out / "stamp-template.svg").write_text(svg, encoding="utf-8")
print(f"created {len(list(out.iterdir()))} files in {out}")
