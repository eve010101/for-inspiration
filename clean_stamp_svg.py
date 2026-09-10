from pathlib import Path
import re

source = Path(r"C:\Users\weimi\Downloads\“移除背景”项目 - 2026年9月02日 10.48.36.svg")
output = Path(r"C:\Users\weimi\Documents\ChatGPT\New project\assets\stamp-clean.svg")
output.parent.mkdir(exist_ok=True)

svg = source.read_text(encoding="utf-8")

# The exported file starts with one full-canvas black background path.
# Remove only that first path; all subsequent vector paths are retained.
first = svg.find('<path')
second = svg.find('<path', first + 5)
match = type('Match', (), {'start': lambda self: first, 'end': lambda self: second})() if first >= 0 and second > first else None
if not match:
    raise SystemExit("Could not identify the exported background path")

cleaned = svg[:match.start()] + svg[match.end():]
cleaned = re.sub(r'\n\s*\n\s*\n+', '\n', cleaned)
output.write_text(cleaned, encoding="utf-8")

print(f"wrote {output}")
print(f"removed background bytes: {match.end() - match.start()}")
print(f"remaining paths: {len(re.findall(r'<path\\b', cleaned))}")
print(f"remaining images: {len(re.findall(r'<image\\b', cleaned))}")
