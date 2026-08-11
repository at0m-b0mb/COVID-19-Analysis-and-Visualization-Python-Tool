#!/usr/bin/env python3
"""Download the two public files the world map is built from.

    python3 tools/fetch_geo_sources.py

They land in ``tools/geo-sources/`` and are committed, so this only needs
running if you want to refresh them. ``build_web_data.py`` consumes them and
bakes the result into ``web/data/core.js``; the site itself never fetches them.
"""

import os
import shutil
import ssl
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "geo-sources")

SOURCES = [
    # Natural Earth 1:110m country outlines, packaged as TopoJSON (ISC licence).
    ("countries-110m.json",
     "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"),
    # ISO 3166-1 codes, used to key the outlines by alpha-2 like the WHO data.
    ("iso-3166.json",
     "https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes"
     "/master/all/all.json"),
]


def download(url):
    """Fetch a URL, falling back to curl when Python has no CA bundle.

    The python.org macOS installers ship without one until you run their
    'Install Certificates.command', which makes urllib fail on a clean machine
    while the system curl works fine.
    """
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return response.read()
    except (ssl.SSLCertVerificationError, urllib.error.URLError) as error:
        # urlopen wraps the SSL failure in a URLError, so unwrap before deciding.
        reason = getattr(error, "reason", error)
        if not isinstance(reason, ssl.SSLCertVerificationError):
            raise
        curl = shutil.which("curl")
        if not curl:
            raise
        print("  (python has no CA bundle - falling back to curl)")
        return subprocess.check_output([curl, "-sSL", "--fail", url])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, url in SOURCES:
        destination = os.path.join(OUT_DIR, name)
        print("Fetching %s ..." % name)
        payload = download(url)
        with open(destination, "wb") as handle:
            handle.write(payload)
        print("  saved %s (%.1f KB)" % (name, len(payload) / 1024.0))


if __name__ == "__main__":
    main()
