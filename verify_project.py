"""Check content, local asset references, and image integrity without changing files."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import re
import xml.etree.ElementTree as ET

from PIL import Image


ROOT = Path(__file__).resolve().parent


def check_reference(source, reference):
    if not reference or reference.startswith(("#", "//")):
        return
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc:
        return
    relative = unquote(parsed.path)
    if not relative:
        return
    target = ROOT / relative.lstrip("/") if relative.startswith("/") else source.parent / relative
    if not target.is_file():
        raise ValueError(f"Missing reference in {source.relative_to(ROOT)}: {reference}")


class References(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.source = source

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("src", "href"):
                check_reference(self.source, value)


def main():
    quotes = json.loads((ROOT / "data" / "quotes.json").read_text(encoding="utf-8"))
    if not quotes or [item["id"] for item in quotes] != list(range(1, len(quotes) + 1)):
        raise ValueError("Quote ids must be sequential from 1 in array order")
    checked = 0
    for item in quotes:
        for field in ("book", "author", "sentence", "chapter"):
            if not isinstance(item.get(field), str):
                raise ValueError(f"Invalid {field} in quote {item['id']}")
        for folder, extension, size in (("stamps", "png", (1024, 1536)), ("previews", "webp", (512, 768))):
            asset = ROOT / "assets" / folder / f"stamp-{item['id']:03d}.{extension}"
            with Image.open(asset) as picture:
                if picture.size != size:
                    raise ValueError(f"Invalid dimensions: {asset}")
                picture.verify()
            checked += 1
    for source in ROOT.glob("*.html"):
        References(source).feed(source.read_text(encoding="utf-8"))
    for source in ROOT.glob("*.css"):
        for match in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", source.read_text(encoding="utf-8")):
            check_reference(source, match.group(2))
    for source in (ROOT / "assets").glob("*.svg"):
        for element in ET.parse(source).iter():
            for attribute, reference in element.attrib.items():
                if attribute.rsplit("}", 1)[-1] == "href":
                    check_reference(source, reference)
    for name in ("stamp-paper.png", "stamp-paper-original.png", "stamp-paper-transparent.png", "stamp-mask.png"):
        with Image.open(ROOT / "assets" / name) as picture:
            if picture.size != (1024, 1536):
                raise ValueError(f"Invalid template dimensions: {name}")
            picture.verify()
    print(f"PASS: {len(quotes)} quotes, {checked} images, templates and local HTML/CSS/SVG references")


if __name__ == "__main__":
    main()
