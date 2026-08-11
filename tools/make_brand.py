#!/usr/bin/env python3
"""Generate the project's brand assets.

    python3 tools/make_brand.py

The mark is not a drawing of a virus - it is the real global epidemic curve,
read straight out of the dashboard's own data bundle and traced. So the logo
means something, and it stays honest: regenerate the data and the logo follows.

Writes SVGs to assets/brand/, and PNGs alongside them when rsvg-convert is
available (GitHub renders PNG more reliably than SVG in a README).
"""

import json
import os
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CORE = os.path.join(ROOT, "web", "data", "core.js")
# Inside web/ deliberately: one copy, which the site can reference and which
# survives being deployed on its own as the Pages root. The README points here.
OUT = os.path.join(ROOT, "web", "brand")

# Brand colours, the same tokens the dashboard uses.
INK = "#0b0e13"
SURFACE = "#12161d"
BLUE = "#3987e5"
BLUE_LIGHT = "#9ec5f4"
BLUE_DEEP = "#0d366b"
TEXT = "#f2f5f8"
MUTED = "#8b95a3"

FONT = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif"


def load_core():
    with open(CORE, encoding="utf-8") as handle:
        source = handle.read()
    payload = source[source.index("JSON.parse(") + 11:source.rindex(");")]
    return json.loads(json.loads(payload))


def curve_points(values, count, width, height, root=True):
    """Downsample to `count` peak-preserving buckets, scaled into a box.

    Peak-preserving matters: a plain stride would sample straight past the
    Omicron spike and the logo would lose the one shape everybody recognises.

    `root` puts the curve on a square-root scale. On a linear scale that one
    spike is so much taller than everything else that the first two years
    flatten into a line and the mark reads as empty. The square root keeps
    every wave visible while preserving their order and the silhouette. It is
    a logo, not a chart - the dashboard itself never rescales like this.
    """
    size = len(values) / float(count)
    peaks = []
    for index in range(count):
        chunk = values[int(index * size):max(int((index + 1) * size), int(index * size) + 1)]
        peaks.append(max(chunk) if chunk else 0)
    if root:
        peaks = [value ** 0.5 for value in peaks]
    top = max(peaks) or 1
    points = []
    for index, value in enumerate(peaks):
        x = width * index / float(count - 1)
        y = height - (value / top) * height
        points.append((x, y))
    return points


def smooth_path(points):
    """Catmull-Rom through the points, emitted as cubic beziers."""
    if len(points) < 2:
        return ""
    parts = ["M%.2f %.2f" % points[0]]
    for index in range(len(points) - 1):
        p0 = points[index - 1] if index > 0 else points[index]
        p1 = points[index]
        p2 = points[index + 1]
        p3 = points[index + 2] if index + 2 < len(points) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6.0, p1[1] + (p2[1] - p0[1]) / 6.0)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6.0, p2[1] - (p3[1] - p1[1]) / 6.0)
        parts.append("C%.2f %.2f %.2f %.2f %.2f %.2f" % (c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]))
    return "".join(parts)


def gradients(prefix):
    return """
  <linearGradient id="%(p)sfill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%%" stop-color="%(light)s" stop-opacity="0.42"/>
    <stop offset="55%%" stop-color="%(blue)s" stop-opacity="0.20"/>
    <stop offset="100%%" stop-color="%(blue)s" stop-opacity="0.02"/>
  </linearGradient>
  <linearGradient id="%(p)sstroke" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%%" stop-color="%(deep)s"/>
    <stop offset="45%%" stop-color="%(blue)s"/>
    <stop offset="100%%" stop-color="%(light)s"/>
  </linearGradient>
  <radialGradient id="%(p)sglow" cx="0.74" cy="0.12" r="0.78">
    <stop offset="0%%" stop-color="%(blue)s" stop-opacity="0.26"/>
    <stop offset="100%%" stop-color="%(blue)s" stop-opacity="0"/>
  </radialGradient>
  <!-- Holds the curve back to a texture under the text, and lets it come
       fully forward on the right where nothing is set. -->
  <linearGradient id="%(p)sscrim" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%%" stop-color="%(ink)s" stop-opacity="0.95"/>
    <stop offset="62%%" stop-color="%(ink)s" stop-opacity="0.82"/>
    <stop offset="94%%" stop-color="%(ink)s" stop-opacity="0"/>
  </linearGradient>
""" % {"p": prefix, "blue": BLUE, "deep": BLUE_DEEP, "light": BLUE_LIGHT, "ink": INK}


def build_mark(values, size=512):
    """Square app icon: the curve inside a rounded tile."""
    pad = size * 0.15
    box = size - pad * 2
    points = curve_points(values, 76, box, box * 0.84)
    offset_y = size - pad - box * 0.84
    shifted = [(x + pad, y + offset_y) for x, y in points]
    line = smooth_path(shifted)
    area = line + "L%.2f %.2f L%.2f %.2f Z" % (
        shifted[-1][0], size - pad, shifted[0][0], size - pad)

    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %(s)d %(s)d" width="%(s)d" height="%(s)d" role="img" aria-label="COVID-19 Dashboard">
<defs>%(defs)s</defs>
<rect width="%(s)d" height="%(s)d" rx="%(r).0f" fill="%(ink)s"/>
<rect width="%(s)d" height="%(s)d" rx="%(r).0f" fill="url(#mglow)"/>
<line x1="%(pad).0f" y1="%(base).0f" x2="%(right).0f" y2="%(base).0f" stroke="%(blue)s" stroke-opacity="0.25" stroke-width="%(hair).1f"/>
<path d="%(area)s" fill="url(#mfill)"/>
<path d="%(line)s" fill="none" stroke="url(#mstroke)" stroke-width="%(sw).1f" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="%(half).1f" y="%(half).1f" width="%(inner).1f" height="%(inner).1f" rx="%(r2).0f" fill="none" stroke="%(blue)s" stroke-opacity="0.16" stroke-width="%(hair).1f"/>
</svg>
""" % {
        "s": size, "r": size * 0.22, "r2": size * 0.22 - size * 0.012,
        "defs": gradients("m"), "ink": INK, "blue": BLUE,
        "pad": pad, "right": size - pad, "base": size - pad,
        "hair": size * 0.006, "sw": size * 0.028,
        "area": area, "line": line,
        "half": size * 0.012, "inner": size - size * 0.024,
    }


def build_logo(values, width=540, height=180):
    """Horizontal lockup: mark, wordmark, rule."""
    mark = 116
    top = (height - mark) / 2.0
    pad = mark * 0.16
    box = mark - pad * 2
    points = curve_points(values, 52, box, box * 0.84)
    offset_y = mark - pad - box * 0.84
    shifted = [(x + pad + 22, y + offset_y + top) for x, y in points]
    line = smooth_path(shifted)
    area = line + "L%.2f %.2f L%.2f %.2f Z" % (
        shifted[-1][0], top + mark - pad, shifted[0][0], top + mark - pad)

    # The wordmark is light, so the lockup carries its own dark panel. Without
    # it the logo disappears on GitHub's white README background.
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %(w)d %(h)d" width="%(w)d" height="%(h)d" role="img" aria-label="COVID-19 Dashboard">
<defs>%(defs)s</defs>
<rect width="%(w)d" height="%(h)d" rx="30" fill="%(ink)s"/>
<rect width="%(w)d" height="%(h)d" rx="30" fill="url(#lglow)"/>
<rect x="22" y="%(top).1f" width="%(mark)d" height="%(mark)d" rx="26" fill="%(surface)s"/>
<rect x="22" y="%(top).1f" width="%(mark)d" height="%(mark)d" rx="26" fill="url(#lglow)"/>
<path d="%(area)s" fill="url(#lfill)"/>
<path d="%(line)s" fill="none" stroke="url(#lstroke)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
<text x="176" y="%(t1).0f" font-family="%(font)s" font-size="46" font-weight="700" letter-spacing="-1.6" fill="%(text)s">COVID-19</text>
<text x="176" y="%(t2).0f" font-family="%(font)s" font-size="23" font-weight="500" letter-spacing="4.4" fill="%(blue)s">D A S H B O A R D</text>
</svg>
""" % {
        "w": width, "h": height, "defs": gradients("l"), "ink": INK,
        "surface": SURFACE,
        "top": top, "mark": mark, "area": area, "line": line,
        "t1": height / 2 - 4, "t2": height / 2 + 30,
        "font": FONT, "text": TEXT, "blue": BLUE,
    }


def build_banner(core, width=1280, height=440):
    """README hero: the curve as the backdrop, headline stats on top."""
    meta = core["meta"]
    values = [v for v in core["global"]["casesAvg"] if v is not None]
    points = curve_points(values, 170, width, height * 0.72)
    offset_y = height - height * 0.72
    shifted = [(x, y + offset_y) for x, y in points]
    line = smooth_path(shifted)
    area = line + "L%.2f %.2f L%.2f %.2f Z" % (width, height, 0, height)

    stats = [
        (compact(meta["totalCases"]), "reported cases"),
        (compact(meta["totalDeaths"]), "reported deaths"),
        (str(meta["countries"]), "countries & areas"),
        (str(meta["days"]), "days tracked"),
    ]
    blocks = []
    for index, (value, label) in enumerate(stats):
        x = 64 + index * 232
        blocks.append(
            '<text x="%d" y="330" font-family="%s" font-size="38" font-weight="680" '
            'letter-spacing="-1.2" fill="%s">%s</text>'
            '<text x="%d" y="358" font-family="%s" font-size="15" font-weight="500" '
            'fill="%s">%s</text>' % (x, FONT, TEXT, escape(value), x, FONT, MUTED, escape(label)))

    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %(w)d %(h)d" width="%(w)d" height="%(h)d" role="img" aria-label="COVID-19 Analysis and Visualization">
<defs>%(defs)s</defs>
<rect width="%(w)d" height="%(h)d" fill="%(ink)s"/>
<rect width="%(w)d" height="%(h)d" fill="url(#bglow)"/>
<path d="%(area)s" fill="url(#bfill)"/>
<path d="%(line)s" fill="none" stroke="url(#bstroke)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<rect width="%(w)d" height="%(h)d" fill="url(#bscrim)"/>
<text x="64" y="118" font-family="%(font)s" font-size="15" font-weight="640" letter-spacing="3.4" fill="%(blue)s">WORLD HEALTH ORGANIZATION &#183; GLOBAL DATA</text>
<text x="64" y="186" font-family="%(font)s" font-size="60" font-weight="700" letter-spacing="-2.6" fill="%(text)s">COVID-19 Analysis &amp; Visualization</text>
<text x="64" y="232" font-family="%(font)s" font-size="24" font-weight="500" letter-spacing="-0.3" fill="%(muted)s">A Python analysis toolkit and an interactive dashboard over three years of WHO data.</text>
<line x1="64" y1="272" x2="%(rule)d" y2="272" stroke="%(blue)s" stroke-opacity="0.28" stroke-width="1"/>
%(blocks)s
</svg>
""" % {
        "w": width, "h": height, "defs": gradients("b"), "ink": INK,
        "area": area, "line": line, "font": FONT, "text": TEXT,
        "blue": BLUE, "muted": MUTED, "rule": width - 64,
        "blocks": "\n".join(blocks),
    }


def build_social(core, width=1280, height=640):
    """GitHub social preview / og:image."""
    meta = core["meta"]
    values = [v for v in core["global"]["casesAvg"] if v is not None]
    points = curve_points(values, 150, width, height * 0.62)
    offset_y = height - height * 0.62
    shifted = [(x, y + offset_y) for x, y in points]
    line = smooth_path(shifted)
    area = line + "L%.2f %.2f L%.2f %.2f Z" % (width, height, 0, height)

    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %(w)d %(h)d" width="%(w)d" height="%(h)d" role="img" aria-label="COVID-19 Dashboard">
<defs>%(defs)s</defs>
<rect width="%(w)d" height="%(h)d" fill="%(ink)s"/>
<rect width="%(w)d" height="%(h)d" fill="url(#sglow)"/>
<path d="%(area)s" fill="url(#sfill)"/>
<path d="%(line)s" fill="none" stroke="url(#sstroke)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
<rect width="%(w)d" height="%(h)d" fill="url(#sscrim)"/>
<text x="80" y="212" font-family="%(font)s" font-size="17" font-weight="640" letter-spacing="4" fill="%(blue)s">WHO GLOBAL DATA &#183; 2020&#8211;2023</text>
<text x="80" y="298" font-family="%(font)s" font-size="76" font-weight="700" letter-spacing="-3.2" fill="%(text)s">COVID-19 Dashboard</text>
<text x="80" y="352" font-family="%(font)s" font-size="27" font-weight="500" fill="%(muted)s">%(cases)s reported cases &#183; %(countries)d countries &#183; %(days)d days</text>
<text x="80" y="404" font-family="%(font)s" font-size="20" font-weight="500" fill="%(blue)s">Hand-drawn SVG charts &#183; no framework, no build step</text>
</svg>
""" % {
        "w": width, "h": height, "defs": gradients("s"), "ink": INK,
        "area": area, "line": line, "font": FONT, "text": TEXT,
        "blue": BLUE, "muted": MUTED,
        "cases": compact(meta["totalCases"]),
        "countries": meta["countries"], "days": meta["days"],
    }


def build_favicon(values, size=64):
    """Tiny mark: fewer points, thicker stroke, no chrome."""
    pad = size * 0.14
    box = size - pad * 2
    points = curve_points(values, 34, box, box * 0.6)
    offset_y = size - pad - box * 0.6
    shifted = [(x + pad, y + offset_y) for x, y in points]
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %(s)d %(s)d" width="%(s)d" height="%(s)d">
<rect width="%(s)d" height="%(s)d" rx="%(r).0f" fill="%(ink)s"/>
<path d="%(line)s" fill="none" stroke="%(blue)s" stroke-width="%(sw).1f" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
""" % {"s": size, "r": size * 0.24, "ink": INK, "blue": BLUE,
       "line": smooth_path(shifted), "sw": size * 0.075}


def escape(text):
    """Any generated string that lands in SVG text has to be XML-safe."""
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def compact(value):
    if value >= 1e9:
        return "%.2fB" % (value / 1e9)
    if value >= 1e6:
        return "%.1fM" % (value / 1e6)
    if value >= 1e3:
        return "%.0fK" % (value / 1e3)
    return str(value)


def write(name, content):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    print("  wrote web/brand/%s (%.1f KB)" % (name, len(content.encode()) / 1024.0))
    return path


def rasterize(svg_path, width):
    tool = shutil.which("rsvg-convert")
    if not tool:
        print("  ! rsvg-convert not found - skipping PNG for %s" % os.path.basename(svg_path))
        return
    png_path = svg_path[:-4] + ".png"
    subprocess.check_call([tool, "-w", str(width), "-o", png_path, svg_path])
    print("  wrote %s (%.1f KB)"
          % (os.path.relpath(png_path, ROOT), os.path.getsize(png_path) / 1024.0))


def main():
    os.makedirs(OUT, exist_ok=True)
    core = load_core()
    values = [value for value in core["global"]["casesAvg"] if value is not None]
    print("Building brand assets from %d days of the global curve ..." % len(values))

    rasterize(write("mark.svg", build_mark(values)), 512)
    rasterize(write("logo.svg", build_logo(values)), 760)
    rasterize(write("banner.svg", build_banner(core)), 1280)
    rasterize(write("social-card.svg", build_social(core)), 1280)
    write("favicon.svg", build_favicon(values))
    print("Done.")


if __name__ == "__main__":
    main()
