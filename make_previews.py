from pathlib import Path
import json
import sys

from PIL import Image


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "assets" / "stamps"
DESTINATION = ROOT / "assets" / "previews"
SIZE = (512, 768)


def main() -> None:
    DESTINATION.mkdir(parents=True, exist_ok=True)
    quotes = json.loads((ROOT / "data" / "quotes.json").read_text(encoding="utf-8"))
    requested = {int(value) for value in sys.argv[1:]}
    sources = [SOURCE / f"stamp-{item['id']:03d}.png" for item in quotes
               if not requested or item["id"] in requested]
    missing = [str(source) for source in sources if not source.is_file()]
    if missing:
        raise SystemExit(f"Missing source stamps: {', '.join(missing)}")

    for source in sources:
        destination = DESTINATION / f"{source.stem}.webp"
        with Image.open(source) as image:
            if image.size != (1024, 1536):
                raise SystemExit(f"Unexpected source size for {source.name}: {image.size}")
            preview = image.resize(SIZE, Image.Resampling.LANCZOS)
            # Lossless WebP changes only dimensions appropriate for the small
            # homepage display. The reader continues to use the original PNG.
            preview.save(destination, "WEBP", lossless=True, method=6, exact=True)

    total = sum(path.stat().st_size for path in DESTINATION.glob("stamp-*.webp"))
    print(f"Generated {len(sources)} lossless previews ({total / 1024 / 1024:.2f} MiB total)")


if __name__ == "__main__":
    main()
