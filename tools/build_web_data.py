#!/usr/bin/env python3
"""Turn the WHO CSV into the compact data bundles the web dashboard reads.

    python3 tools/build_web_data.py

Reads ``covid_data.csv`` and writes ``web/data/core.js`` and ``web/data/series.js``.

Two deliberate choices:

*   **Standard library only.** No pandas, so anyone can regenerate the site with a
    bare Python install.
*   **.js, not .json.** The bundles assign a JSON string to a global instead of
    being fetched. ``fetch()`` is blocked on ``file://``, so a plain JSON build
    would force everyone to run a web server just to look at the page; a script
    tag works either way. The payload is still parsed with ``JSON.parse``, which
    is markedly faster than parsing the same data as a JavaScript literal.
"""

import csv
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSV_PATH = os.path.join(ROOT, "covid_data.csv")
OUT_DIR = os.path.join(ROOT, "web", "data")

# Assets for the map. Regenerate with tools/fetch_geo_sources.py.
GEO_DIR = os.path.join(HERE, "geo-sources")
TOPO_PATH = os.path.join(GEO_DIR, "countries-110m.json")
ISO_PATH = os.path.join(GEO_DIR, "iso-3166.json")

SOURCE_NAME = "WHO COVID-19 Global Data"
SOURCE_URL = "https://covid19.who.int/"

REGION_NAMES = {
    "AFRO": "Africa",
    "AMRO": "Americas",
    "EMRO": "Eastern Mediterranean",
    "EURO": "Europe",
    "SEARO": "South-East Asia",
    "WPRO": "Western Pacific",
    "Other": "Other",
}
# Fixed order = fixed colour slot. A region keeps its hue no matter how the
# chart is filtered, which is the whole point of assigning colour by entity.
REGION_ORDER = ["AMRO", "EURO", "WPRO", "SEARO", "EMRO", "AFRO", "Other"]

# The pseudo-entry WHO uses for cruise ships and repatriation flights. It has a
# blank country code in the CSV, so it needs a synthetic one to be keyable.
CONVEYANCE_CODE = "XI"

WAVE_ROWS = 24  # countries shown in the wave calendar


def log(message):
    sys.stdout.write(message + "\n")
    sys.stdout.flush()


def read_csv(path):
    """Group the CSV into {code: {name, region, rows}} with rows in date order."""
    countries = {}
    dates = set()
    with open(path, encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            code = (row["Country_code"] or "").strip() or CONVEYANCE_CODE
            entry = countries.get(code)
            if entry is None:
                entry = countries[code] = {
                    "name": row["Country"].strip(),
                    "region": row["WHO_region"].strip() or "Other",
                    "rows": {},
                }
            date = row["Date_reported"]
            dates.add(date)
            entry["rows"][date] = (
                int(row["New_cases"] or 0),
                int(row["Cumulative_cases"] or 0),
                int(row["New_deaths"] or 0),
                int(row["Cumulative_deaths"] or 0),
            )
    return countries, sorted(dates)


def check_calendar(dates):
    """The site indexes every series by day offset, so the dates must be a run."""
    start = dt.date.fromisoformat(dates[0])
    end = dt.date.fromisoformat(dates[-1])
    expected = (end - start).days + 1
    if expected != len(dates):
        raise SystemExit(
            "Dates are not a contiguous daily run: %d days between %s and %s "
            "but %d distinct dates." % (expected, dates[0], dates[-1], len(dates))
        )
    return start, end


def clean_name(name):
    """Strip the footnote markers WHO leaves in a few country names."""
    if name.endswith("]"):
        bracket = name.rfind("[")
        if bracket > 0:
            return name[:bracket].strip()
    return name


def rolling_mean(values, window=7):
    """Trailing mean, rounded to one decimal. None until the window is full."""
    out = [None] * len(values)
    total = 0
    for index, value in enumerate(values):
        total += value
        if index >= window:
            total -= values[index - window]
        if index >= window - 1:
            out[index] = round(total / float(window), 1)
    return out


def month_keys(start, count):
    """Month label per day offset, plus the ordered list of months covered."""
    labels = []
    seen = []
    for offset in range(count):
        day = start + dt.timedelta(days=offset)
        key = "%04d-%02d" % (day.year, day.month)
        if not seen or seen[-1] != key:
            seen.append(key)
        labels.append(key)
    return labels, seen


def weekly(values, size=7):
    """Sum into fixed buckets; the tail keeps whatever partial week is left."""
    return [sum(values[index:index + size]) for index in range(0, len(values), size)]


def build():
    if not os.path.exists(CSV_PATH):
        raise SystemExit("Missing %s - run '1. Data_Collection.py' first." % CSV_PATH)

    log("Reading %s ..." % os.path.basename(CSV_PATH))
    countries, dates = read_csv(CSV_PATH)
    start, end = check_calendar(dates)
    day_count = len(dates)
    log("  %d countries/areas, %d days, %s to %s" % (len(countries), day_count, dates[0], dates[-1]))

    # The dashboard's period presets are whole calendar years, so the per-year
    # totals can be precomputed. That lets the map, the ranking and the table
    # answer any preset exactly, without waiting for the large daily bundle.
    years = sorted({date[:4] for date in dates})
    year_of_day = [date[:4] for date in dates]
    year_ranges = {}
    for offset, year in enumerate(year_of_day):
        span = year_ranges.setdefault(year, [offset, offset])
        span[1] = offset

    # --- per-country daily series, aligned to one shared calendar -------------
    series = {}
    index = []
    corrections = 0
    for code, entry in countries.items():
        cases = [0] * day_count
        deaths = [0] * day_count
        last_cumulative_cases = 0
        last_cumulative_deaths = 0
        for offset, date in enumerate(dates):
            row = entry["rows"].get(date)
            if row is None:
                continue
            new_cases, cumulative_cases, new_deaths, cumulative_deaths = row
            cases[offset] = new_cases
            deaths[offset] = new_deaths
            last_cumulative_cases = cumulative_cases
            last_cumulative_deaths = cumulative_deaths
            if new_cases < 0 or new_deaths < 0:
                corrections += 1

        # WHO's own cumulative column is the authoritative total: summing the
        # daily column drifts wherever a country restated its back-series.
        series[code] = [cases, deaths]
        index.append({
            "c": code,
            "n": clean_name(entry["name"]),
            "r": entry["region"] if entry["region"] in REGION_NAMES else "Other",
            "tc": last_cumulative_cases,
            "td": last_cumulative_deaths,
            "yc": [sum(cases[year_ranges[year][0]:year_ranges[year][1] + 1]) for year in years],
            "yd": [sum(deaths[year_ranges[year][0]:year_ranges[year][1] + 1]) for year in years],
        })

    index.sort(key=lambda item: (-item["tc"], item["n"]))
    log("  %d country-days carry a negative (restated) value" % corrections)

    # --- global daily totals -------------------------------------------------
    global_cases = [0] * day_count
    global_deaths = [0] * day_count
    for cases, deaths in series.values():
        for offset in range(day_count):
            global_cases[offset] += cases[offset]
            global_deaths[offset] += deaths[offset]

    total_cases = sum(item["tc"] for item in index)
    total_deaths = sum(item["td"] for item in index)

    peak_cases = max(range(day_count), key=lambda offset: global_cases[offset])
    peak_deaths = max(range(day_count), key=lambda offset: global_deaths[offset])

    # --- WHO region series, weekly ------------------------------------------
    region_totals = {key: [0] * day_count for key in REGION_NAMES}
    region_death_totals = {key: [0] * day_count for key in REGION_NAMES}
    by_code = {item["c"]: item for item in index}
    for code, (cases, deaths) in series.items():
        region = by_code[code]["r"]
        bucket = region_totals[region]
        death_bucket = region_death_totals[region]
        for offset in range(day_count):
            bucket[offset] += cases[offset]
            death_bucket[offset] += deaths[offset]

    regions = []
    for key in REGION_ORDER:
        regions.append({
            "k": key,
            "n": REGION_NAMES[key],
            "cases": weekly(region_totals[key]),
            "deaths": weekly(region_death_totals[key]),
            "tc": sum(item["tc"] for item in index if item["r"] == key),
            "td": sum(item["td"] for item in index if item["r"] == key),
        })

    # --- wave calendar: when each country's cases actually landed ------------
    day_months, months = month_keys(start, day_count)
    month_position = {month: position for position, month in enumerate(months)}
    wave_rows = []
    for item in index[:WAVE_ROWS]:
        monthly = [0] * len(months)
        for offset, value in enumerate(series[item["c"]][0]):
            if value > 0:
                monthly[month_position[day_months[offset]]] += value
        peak = max(monthly) or 1
        wave_rows.append({
            "c": item["c"],
            "n": item["n"],
            # Share of the country's own worst month, so a small country's wave
            # is as visible as a large one's. Absolute counts ride in the tooltip.
            "v": [round(value / float(peak), 4) for value in monthly],
            "a": monthly,
        })

    # --- map -----------------------------------------------------------------
    map_data = build_map(set(by_code))

    core = {
        "meta": {
            "source": SOURCE_NAME,
            "sourceUrl": SOURCE_URL,
            "start": dates[0],
            "end": dates[-1],
            "days": day_count,
            "countries": len(index),
            "generated": dt.datetime.now().strftime("%Y-%m-%d"),
            "totalCases": total_cases,
            "totalDeaths": total_deaths,
            "peakCasesDay": peak_cases,
            "peakCasesValue": global_cases[peak_cases],
            "peakDeathsDay": peak_deaths,
            "peakDeathsValue": global_deaths[peak_deaths],
            "conveyanceCode": CONVEYANCE_CODE,
            "corrections": corrections,
            "years": years,
            "yearRanges": [year_ranges[year] for year in years],
        },
        "global": {
            "cases": global_cases,
            "deaths": global_deaths,
            "casesAvg": rolling_mean(global_cases),
            "deathsAvg": rolling_mean(global_deaths),
        },
        "countries": index,
        "regions": regions,
        "regionWeeks": len(regions[0]["cases"]),
        "waves": {"months": months, "rows": wave_rows},
        "map": map_data,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    write_bundle(os.path.join(OUT_DIR, "core.js"), "core", core)
    write_bundle(os.path.join(OUT_DIR, "series.js"), "series", series)
    log("Done.")


def build_map(known_codes):
    """Projected country outlines, or an empty map if the sources are absent."""
    if not (os.path.exists(TOPO_PATH) and os.path.exists(ISO_PATH)):
        log("  ! map sources missing - run tools/fetch_geo_sources.py; "
            "the dashboard will hide the map")
        return {"viewBox": [0, 0, 1000, 500], "paths": {}, "missing": []}

    sys.path.insert(0, HERE)
    import geo

    topology = json.load(open(TOPO_PATH, encoding="utf-8"))
    iso = geo.load_iso_map(ISO_PATH)
    # Antarctica has no population and no reported cases; drawing it would cost
    # a third of the map's height for a permanently empty shape.
    paths, view_box = geo.build_paths(
        topology, "countries", iso, width=1000.0, skip={"AQ"}, min_area=1.0
    )
    drawable = {code: path for code, path in paths.items() if code in known_codes}
    missing = sorted(known_codes - set(drawable) - {CONVEYANCE_CODE})
    log("  map: %d of %d countries have an outline at this resolution"
        % (len(drawable), len(known_codes) - 1))
    return {"viewBox": view_box, "paths": drawable, "missing": missing}


def write_bundle(path, key, payload):
    """Write ``window.__COVID__.<key> = JSON.parse('...')``."""
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    body = (
        "// Generated by tools/build_web_data.py - do not edit by hand.\n"
        "window.__COVID__ = window.__COVID__ || {};\n"
        "window.__COVID__.%s = JSON.parse(%s);\n"
        % (key, json.dumps(encoded, ensure_ascii=False))
    )
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(body)
    log("  wrote %s (%.1f KB)" % (os.path.relpath(path, ROOT), len(body.encode("utf-8")) / 1024.0))


if __name__ == "__main__":
    build()
