"""Build the Heyzine upload PDF and website assets from magazine/pages/.

Drop the page images (page-01.jpg ... page-36.jpg, square, in reading order)
into magazine/pages/ and run:

    python scripts/build_magazine.py

Outputs in magazine/dist/:
    foodstories-magazine.pdf   upload this to Heyzine
    cover.jpg                  1200px cover for the website / social share image
    thumbs/page-NN.jpg         600px thumbnails
    manifest.json              page list + sizes for the website
    preview.html               open locally to check page order as spreads
    flipbook/                  self-hosted 3D flipbook (serve over http, see README)
"""

import argparse
import json
import re
import shutil
import sys
from io import BytesIO
from pathlib import Path

import pymupdf
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = ROOT / "magazine" / "pages"
DIST_DIR = ROOT / "magazine" / "dist"
FLIPBOOK_SRC = ROOT / "web" / "flipbook"
PDF_NAME = "foodstories-magazine.pdf"
TITLE = "Food Stories Magazine"
PAGE_PT = 576  # 8 in square at 72 pt/in; Heyzine only uses the ratio, pixels come from the images
EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def natural_key(p):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]


def jpeg_bytes(path, max_px, quality):
    """Return JPEG bytes for the page; untouched if it's already a small-enough JPEG."""
    with Image.open(path) as im:
        w, h = im.size
        if im.format == "JPEG" and im.mode in ("RGB", "L") and max(w, h) <= max_px:
            return path.read_bytes(), (w, h), False
        im = im.convert("RGB")
        if max(w, h) > max_px:
            im.thumbnail((max_px, max_px), Image.LANCZOS)
        buf = BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
        return buf.getvalue(), im.size, True


def save_small(path, out, px, quality=82, sharpen=False):
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((px, px), Image.LANCZOS)
        if sharpen:
            # shrinking softens small type; restore its edge contrast
            im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=70, threshold=2))
        out.parent.mkdir(parents=True, exist_ok=True)
        im.save(out, "JPEG", quality=quality, optimize=True, progressive=True)


def write_preview(pages, out):
    # Cover alone, then spreads, then back cover alone, the way Heyzine shows them.
    units = [[pages[0]]] + [pages[i:i + 2] for i in range(1, len(pages) - 1, 2)]
    if len(pages) > 1 and len(pages) % 2 == 0:
        units.append([pages[-1]])
    rows = []
    for u in units:
        imgs = "".join(f'<figure><img src="thumbs/{p}" loading="lazy" alt=""><figcaption>{int(re.findall(r"\d+", p)[-1])}</figcaption></figure>' for p in u)
        rows.append(f'<div class="spread{" single" if len(u) == 1 else ""}">{imgs}</div>')
    out.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magazine Preview</title>
<style>
body{{margin:0;padding:24px 16px;font:14px/1.4 system-ui,sans-serif;background:#efe9df;color:#201814}}
h1{{font-size:20px;margin:0 0 4px}}p{{margin:0 0 24px;color:#6b5e55}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}}
.spread{{display:flex;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.12);background:#fff}}
.spread.single{{background:none;box-shadow:none}}
figure{{margin:0;flex:0 1 50%;position:relative}}figure img{{display:block;width:100%;aspect-ratio:1;object-fit:cover}}
figcaption{{position:absolute;bottom:4px;left:6px;font-size:11px;background:#fffc;padding:0 5px;border-radius:8px}}
</style></head><body>
<h1>{TITLE} preview</h1><p>{len(pages)} pages, shown as spreads in flipbook order. Check the order before uploading <code>{PDF_NAME}</code> to Heyzine.</p>
<div class="grid">{"".join(rows)}</div>
</body></html>
""", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pages", type=Path, default=PAGES_DIR)
    ap.add_argument("--out", type=Path, default=DIST_DIR)
    ap.add_argument("--expect", type=int, default=36, help="expected page count (0 to skip check)")
    ap.add_argument("--max-px", type=int, default=2400, help="downscale pages larger than this (keeps the PDF upload-friendly)")
    ap.add_argument("--quality", type=int, default=88, help="JPEG quality used when a page has to be re-encoded")
    ap.add_argument("--flip-px", type=int, default=1600, help="page size for the flipbook (zoom uses the full-size pages)")
    args = ap.parse_args()

    files = sorted((p for p in args.pages.iterdir() if p.suffix.lower() in EXTS), key=natural_key)
    if not files:
        sys.exit(f"No page images found in {args.pages}")
    if args.expect and len(files) != args.expect:
        sys.exit(f"Found {len(files)} pages in {args.pages}, expected {args.expect}. Use --expect {len(files)} if that's intended.")
    if len(files) % 2:
        print(f"! Warning: {len(files)} pages is odd; the back cover will sit on a left-hand page.")

    if args.out.exists():
        shutil.rmtree(args.out)
    (args.out / "thumbs").mkdir(parents=True)
    flip_dir = args.out / "flipbook"
    shutil.copytree(FLIPBOOK_SRC, flip_dir)
    for sub in ("pages-hd", "pages-xs"):
        (flip_dir / sub).mkdir()

    doc = pymupdf.open()
    manifest_pages = []
    for i, path in enumerate(files, 1):
        data, (w, h), reencoded = jpeg_bytes(path, args.max_px, args.quality)
        if abs(w / h - 1) > 0.01:
            print(f"! Warning: {path.name} is {w}x{h}, not square; it will be fitted as-is.")
        page = doc.new_page(width=PAGE_PT, height=PAGE_PT * h / w)
        page.insert_image(page.rect, stream=data)
        thumb = f"page-{i:02d}.jpg"
        save_small(path, args.out / "thumbs" / thumb, 600)
        save_small(path, flip_dir / "pages" / thumb, args.flip_px, 88, sharpen=True)
        save_small(path, flip_dir / "pages-sm" / thumb, 1024, 88, sharpen=True)
        shutil.copyfile(args.out / "thumbs" / thumb, flip_dir / "pages-xs" / thumb)
        (flip_dir / "pages-hd" / thumb).write_bytes(data)
        manifest_pages.append({"page": i, "source": path.name, "thumb": f"thumbs/{thumb}", "width": w, "height": h})
        print(f"  {i:2d}  {path.name}  {w}x{h}{'  (resized/re-encoded)' if reencoded else ''}")

    doc.set_metadata({"title": TITLE, "author": "Food Stories", "subject": "foodstories.shop"})
    pdf_path = args.out / PDF_NAME
    doc.save(pdf_path, garbage=3, deflate=True)
    save_small(files[0], args.out / "cover.jpg", 1200)

    (args.out / "manifest.json").write_text(json.dumps({
        "title": TITLE,
        "pageCount": len(files),
        "pdf": PDF_NAME,
        "cover": "cover.jpg",
        "pages": manifest_pages,
    }, indent=2), encoding="utf-8")
    write_preview([p["thumb"].split("/")[-1] for p in manifest_pages], args.out / "preview.html")
    names = [p["thumb"].split("/")[-1] for p in manifest_pages]
    (flip_dir / "pages.js").write_text("window.FLIPBOOK = " + json.dumps({
        "title": TITLE,
        "pages": [f"pages/{n}" for n in names],
        "zoom": [f"pages-hd/{n}" for n in names],
        "sm": [f"pages-sm/{n}" for n in names],
        "xs": [f"pages-xs/{n}" for n in names],
    }, indent=2) + ";\n", encoding="utf-8")

    mb = pdf_path.stat().st_size / 1e6
    print(f"\nBuilt {pdf_path.relative_to(ROOT)}  ({len(files)} pages, {mb:.1f} MB)")
    print(f"Preview: {(args.out / 'preview.html').relative_to(ROOT)}")
    print(f"Flipbook: {(flip_dir / 'index.html').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
