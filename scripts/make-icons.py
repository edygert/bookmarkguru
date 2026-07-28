#!/usr/bin/env python3
"""
Generates the extension icons.

Source of truth for `public/icons/*.png`, which the manifest references. Committed so
the icons are reproducible rather than opaque binaries nobody can edit.

    python3 scripts/make-icons.py        # needs Pillow; only to regenerate

The design follows the two choices that carry the product's identity (see tokens.css):

  * Indigo is the base — the same --accent the UI uses for selection and focus.
  * Amber marks "open in a tab right now", and is reserved exclusively for that. It is
    the one thing the browser's own bookmark manager cannot tell you, so the icon is a
    stack of saved links with one of them lit: the product in a single glyph.

Rows are drawn with a leading dot, echoing BookmarkRow's layout. Below 32px the dots are
dropped and the bars tighten: a dot would land on well under a pixel and turn to mud.
The row *count* stays at three at every size — two bars read as an equals sign, which was
the first attempt and had to be thrown away.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = (16, 32, 48, 128)

INDIGO = (67, 56, 202, 255)     # --accent
AMBER = (252, 211, 77, 255)     # --signal (dark-theme value; brighter on the indigo)
LIGHT = (255, 255, 255, 235)
FAINT = (255, 255, 255, 130)

SS = 8  # supersample factor; drawn large, then reduced with LANCZOS for clean edges


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    detailed = size >= 32
    rows = 3
    lit = 1  # which row is "open now"

    # Base tile. Chrome renders the action icon small and unpadded, so the tile runs
    # nearly full bleed with just enough corner radius to read as a rounded square.
    rounded(d, (0, 0, s - 1, s - 1), radius=int(s * (0.22 if detailed else 0.20)), fill=INDIGO)

    pad = s * (0.19 if detailed else 0.13)
    bar_h = s * (0.10 if detailed else 0.115)
    gap = s * (0.09 if detailed else 0.075)
    total = rows * bar_h + (rows - 1) * gap
    top = (s - total) / 2

    dot_d = s * 0.085 if detailed else 0
    dot_gap = s * 0.06 if detailed else 0

    for i in range(rows):
        y = top + i * (bar_h + gap)
        colour = AMBER if i == lit else (LIGHT if i == 0 else FAINT)

        x = pad
        if detailed:
            # The leading dot: filled on the lit row, hollow elsewhere — the same
            # distinction BookmarkRow draws between open and not-open.
            cy = y + bar_h / 2
            box = (x, cy - dot_d / 2, x + dot_d, cy + dot_d / 2)
            if i == lit:
                d.ellipse(box, fill=colour)
            else:
                d.ellipse(box, outline=colour, width=max(1, int(s * 0.012)))
            x += dot_d + dot_gap

        # Rows shorten going down, so the stack reads as a list rather than a barcode.
        right = s - pad - (0 if i == lit else s * (0.06 if detailed else 0.07) * i)
        rounded(d, (x, y, right, y + bar_h), radius=bar_h / 2, fill=colour)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        render(size).save(path)
        print(f"  wrote {path.relative_to(OUT.parent.parent)}")


if __name__ == "__main__":
    main()
