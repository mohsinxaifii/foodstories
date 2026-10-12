"""Split the designer's spread PDF into single square page JPEGs.

The artwork PDF has 18 artboards (1872 x 1008 pt). Each holds a two-page spread
trimmed at the crop marks to 1728 x 864 pt, i.e. two 12 x 12 in pages:

    artboard 1:   back cover (36) | front cover (1)
    artboard k:   page 2k-2       | page 2k-1        (k = 2..18)

Usage:
    python scripts/extract_pages.py "/mnt/c/Users/mohsi/Downloads/FS Guide Design Artwork file.pdf"
    python scripts/extract_pages.py artwork.pdf --px 3000

Writes magazine/pages/page-01.jpg ... page-36.jpg (replacing what's there),
then run build_magazine.py.
"""

import argparse
import sys
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "magazine" / "pages"

ARTBOARD = (1872, 1008)
TRIM = pymupdf.Rect(72, 72, 1800, 936)  # inside the crop marks, bleed excluded


def page_numbers(artboard_index, total_pages):
    """(left, right) page numbers for a 0-based artboard index."""
    if artboard_index == 0:
        return total_pages, 1
    return 2 * artboard_index, 2 * artboard_index + 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    ap.add_argument("--px", type=int, default=2400, help="output page size in pixels (default 2400)")
    ap.add_argument("--quality", type=int, default=90)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    total = doc.page_count * 2
    for i, page in enumerate(doc):
        size = (round(page.rect.width), round(page.rect.height))
        if size != ARTBOARD:
            sys.exit(f"Artboard {i + 1} is {size[0]}x{size[1]} pt, expected {ARTBOARD[0]}x{ARTBOARD[1]}. The layout changed; update TRIM.")

    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("page-*.jpg"):
        old.unlink()

    half = TRIM.width / 2
    zoom = args.px / half
    for i, page in enumerate(doc):
        left_no, right_no = page_numbers(i, total)
        for n, x0 in ((left_no, TRIM.x0), (right_no, TRIM.x0 + half)):
            clip = pymupdf.Rect(x0, TRIM.y0, x0 + half, TRIM.y1)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            if img.size != (args.px, args.px):
                img = img.resize((args.px, args.px), Image.LANCZOS)
            path = args.out / f"page-{n:02d}.jpg"
            img.save(path, "JPEG", quality=args.quality, optimize=True, progressive=True)
            print(f"  artboard {i + 1:2d} -> {path.relative_to(ROOT)}")
    print(f"Done: {total} pages at {args.px}x{args.px}px in {args.out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
