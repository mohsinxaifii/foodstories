# Food Stories Magazine — interactive flipbook

The designer's artwork PDF is turned into 36 square pages, then into a realistic page-turning flipbook
for www.foodstories.shop (Next.js on Vercel). It can be self-hosted, or you can upload the PDF to Heyzine.

```
scripts/extract_pages.py      artwork PDF (18 spreads) → magazine/pages/page-01.jpg … page-36.jpg
scripts/build_magazine.py     magazine/pages/ → magazine/dist/
magazine/dist/
  flipbook/                   ← self-hosted 3D flipbook (preview with a local server, see below)
  foodstories-magazine.pdf    ← upload this to Heyzine (if you use Heyzine)
  cover.jpg                   ← 1200px cover for the website / share image
  preview.html, thumbs/       ← quick page-order check
web/flipbook/                 flipbook source (HTML/CSS/JS + vendored three.js r159, MIT)
web/components/               MagazineFlipbook.jsx + .module.css for the Next.js site
web/heyzine-embed.html        plain-HTML embed for anywhere else
```

## Build

```bash
.venv/bin/python scripts/extract_pages.py "/mnt/c/Users/mohsi/Downloads/FS Guide Design Artwork file.pdf"
.venv/bin/python scripts/build_magazine.py
```

The artwork PDF has 18 artboards. Each one is a spread trimmed at the crop marks to two 12 × 12 in pages.
Artboard 1 is back cover (36) | front cover (1), and artboard *k* is pages 2k−2 | 2k−1.
If the designer changes the artboard size or crop marks, the extract script stops and says so.

When a new version of the artwork arrives, run both commands again.
To set up on another machine: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## The flipbook

A real 3D magazine built with three.js (WebGL). Each sheet is a bendable 3D surface hinged at the spine.

- **Paper physics:** a turning page folds around a cylinder whose fold line is always perpendicular to the pull, so it follows your cursor. A grabbed corner peels into a tight curl, the curl widens into an arch mid-turn, and the page settles flat on the other side. It stays attached at the spine, so you can't pull it further than real paper would go.
- **Depth and light:** the book is seen from above. A lamp light shades the pages by their actual shape, and turning pages cast soft shadows onto the pages below and onto the table. Pages dip into the spine, so the gutter darkens naturally.
- **Coated paper:** pages have a soft magazine sheen that reflects a studio light. Flat pages show a gentle glare, and highlights sweep along a page as it bends. The lighting is calibrated so the artwork keeps its true colours.
- **Smooth on low-end devices:**
  - Phones and low-power machines start with a lighter setup: a simpler page mesh, smaller shadow maps, no anti-aliasing, and page images no larger than 1600px.
  - While pages move, the flipbook watches its frame rate and lowers or raises the rendering resolution to stay fluid.
  - Page shapes and shadows are only recalculated when something moved.
  - New page images are sent to the GPU between turns, so they never cause a hitch mid-turn.
- **Interaction:**
  - Drag a page (the corner you grab leads) or swipe on phones.
  - Click a page, use the arrows, or use ←/→ keys.
  - Corners lift when the mouse is near them.
- **Rapid turns are never skipped:** every press starts its own sheet. Quick presses turn into a riffle of pages in the air, and pressing back mid-turn reverses the page from where it is.
- **Layout:** the closed book lies centred and slides over as it opens. Phones show one page at a time.
- **Extras:** zoom to read small text, full screen, and links to a page such as `#page=14`.
- **Image sizes:** pages are loaded near the reader at a size that matches the screen (1024 / 1600 / 2400px), with 600px stand-ins.

Browsers only allow WebGL textures over http, so preview it with a local server instead of double-clicking the file:

```bash
python3 -m http.server 8765 -d magazine/dist/flipbook
# then open http://localhost:8765
```

## Put it on foodstories.shop

### Option A — self-hosted (no Heyzine needed)

1. Copy `magazine/dist/flipbook/` into the Next.js project as `public/magazine/flipbook/`.
2. Copy `magazine/dist/cover.jpg` to `public/magazine/cover.jpg`.
3. Copy `web/components/MagazineFlipbook.jsx` and `MagazineFlipbook.module.css` into `components/`.
4. Add a page, e.g. `app/magazine/page.jsx` (App Router):

```jsx
import MagazineFlipbook from '@/components/MagazineFlipbook';

export const metadata = {
  title: 'Food Stories Magazine',
  openGraph: { images: ['/magazine/cover.jpg'] },
};

export default function MagazinePage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 16px' }}>
      <MagazineFlipbook src="/magazine/flipbook/index.html" autoLoad />
    </main>
  );
}
```

With the Pages Router, use `pages/magazine.jsx` and `next/head` instead of `metadata`.
`/magazine/flipbook/index.html` also works as a full-screen page that you can link to directly.

### Option B — Heyzine

Upload `magazine/dist/foodstories-magazine.pdf` on heyzine.com and copy the flipbook link.
Then use the same component with `src="https://heyzine.com/flip-book/XXXXXXXX.html"`.
When new artwork arrives, replace the PDF on the same flipbook in Heyzine (if your plan allows it) so the link stays the same.

### The component

Without `autoLoad`, `MagazineFlipbook` shows the cover with a "Read the magazine" button and loads the flipbook only on click.
That's good for a homepage section. It shows a 2:1 spread on desktop and a single page on phones.
