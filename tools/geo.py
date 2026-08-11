"""TopoJSON -> projected SVG paths.

Turns the Natural Earth 110m country outlines into ready-to-draw SVG path data
keyed by ISO 3166-1 alpha-2, which is the same key the WHO data uses. Doing the
projection here means the browser never needs a mapping library.

Standard library only.
"""

import json
import math

# Robinson projection lookup table, latitude 0..90 in 5 degree steps.
# X scales the parallel's length, Y is the parallel's distance from the equator.
_ROBINSON_X = [
    1.0000, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600, 0.9427, 0.9216,
    0.8962, 0.8679, 0.8350, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722,
    0.5322,
]
_ROBINSON_Y = [
    0.0000, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720, 0.4340, 0.4958,
    0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761,
    1.0000,
]


def _interpolate(table, position):
    """Linear interpolation into a 5-degree table; sub-pixel accurate at map scale."""
    low = int(position)
    if low >= len(table) - 1:
        return table[-1]
    fraction = position - low
    return table[low] + (table[low + 1] - table[low]) * fraction


def robinson(lon, lat):
    """Project degrees to unit-ish Robinson coordinates (y already points up)."""
    position = abs(lat) / 5.0
    x = 0.8487 * _interpolate(_ROBINSON_X, position) * math.radians(lon)
    y = 1.3523 * _interpolate(_ROBINSON_Y, position)
    return x, (y if lat >= 0 else -y)


def decode_arcs(topology):
    """Undo TopoJSON's quantised delta encoding into absolute lon/lat arcs."""
    scale_x, scale_y = topology["transform"]["scale"]
    translate_x, translate_y = topology["transform"]["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale_x + translate_x, y * scale_y + translate_y))
        arcs.append(points)
    return arcs


def _ring_points(arcs, ring):
    """Stitch a ring's arc indices into one point list (negative index = reversed)."""
    points = []
    for index in ring:
        if index < 0:
            arc = arcs[~index][::-1]
        else:
            arc = arcs[index]
        # The shared endpoint between consecutive arcs would otherwise repeat.
        points.extend(arc[1:] if points else arc)
    return points


def _numeric_id(value):
    """TopoJSON writes '004' where the ISO dump writes '4' - normalise both to '4'."""
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return ""


def _split_antimeridian(points):
    """Cut a ring wherever it jumps the 180th meridian.

    Russia and Fiji both straddle the date line. Projected naively, the jump
    from +179 to -179 draws a hairline right across the whole map. Splitting
    the ring there yields one piece per side, which is what the map should
    show anyway.
    """
    pieces = []
    current = [points[0]]
    for previous, point in zip(points, points[1:]):
        if abs(point[0] - previous[0]) > 180:
            pieces.append(current)
            current = []
        current.append(point)
    pieces.append(current)
    return [piece for piece in pieces if len(piece) > 2]


def _polygons(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["arcs"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["arcs"]
    return []


def build_paths(topology, object_name, id_to_key, width=1000.0, skip=(), min_area=0.0):
    """Return {key: svg path data}, plus the viewBox the paths were drawn into.

    Coordinates are rounded to one decimal, which keeps the file small without
    any visible loss at the sizes this map is drawn at.
    """
    arcs = decode_arcs(topology)
    geometries = topology["objects"][object_name]["geometries"]

    # First pass: project everything so the extent (and therefore the scale) is known.
    projected = {}
    for geometry in geometries:
        key = id_to_key.get(_numeric_id(geometry.get("id")))
        if not key or key in skip:
            continue
        rings = []
        for polygon in _polygons(geometry):
            for ring in polygon:
                for piece in _split_antimeridian(_ring_points(arcs, ring)):
                    points = [robinson(lon, lat) for lon, lat in piece]
                    if len(points) > 2:
                        rings.append(points)
        if rings:
            projected.setdefault(key, []).extend(rings)

    xs = [x for rings in projected.values() for ring in rings for x, _ in ring]
    ys = [y for rings in projected.values() for ring in rings for _, y in ring]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    scale = width / (max_x - min_x)
    height = (max_y - min_y) * scale

    def to_screen(point):
        x, y = point
        # Flip y: projection space points up, screen space points down.
        return (x - min_x) * scale, (max_y - y) * scale

    paths = {}
    for key, rings in projected.items():
        pieces = []
        for ring in rings:
            screen = [to_screen(point) for point in ring]
            if _area(screen) < min_area:
                continue
            drawn = []
            last = None
            for x, y in screen:
                rounded = (round(x, 1), round(y, 1))
                if rounded != last:
                    drawn.append(rounded)
                    last = rounded
            if len(drawn) < 3:
                continue
            head = drawn[0]
            body = " ".join("%g %g" % point for point in drawn[1:])
            pieces.append("M%g %gL%sZ" % (head[0], head[1], body))
        if pieces:
            paths[key] = "".join(pieces)

    return paths, [0, 0, round(width, 1), round(height, 1)]


def _area(ring):
    """Absolute shoelace area, used to drop specks too small to render."""
    total = 0.0
    for index in range(len(ring)):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % len(ring)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def load_iso_map(path):
    """{ISO numeric code (unpadded string) -> alpha-2} from the ISO-3166 dump."""
    with open(path, encoding="utf-8") as handle:
        entries = json.load(handle)
    return {str(int(entry["country-code"])): entry["alpha-2"] for entry in entries}
