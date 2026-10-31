#!/usr/bin/env python3
"""Fetch S&P 500 + Nasdaq-100 constituent tickers from Wikipedia.

Writes committed snapshots to backend/src/data/*.ts (small config-like data,
safe to commit). Re-run occasionally: index membership drifts over time.

Usage: python3 backend/scripts/fetch_constituents.py
"""

import datetime
import json
import os
import urllib.request
from html.parser import HTMLParser

UA = {"User-Agent": "WhoFundsIt/0.1 (contact: dev@example.com)"}
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "data")

SOURCES = {
    "sp500": (
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        "SP500_TICKERS",
        "Symbol",
    ),
    "nasdaq100": (
        "https://www.slickcharts.com/nasdaq100",
        "NASDAQ100_TICKERS",
        "Symbol",
    ),
}


class TableParser(HTMLParser):
    """Collects (headers, rows) text for every <table> in a page."""

    def __init__(self):
        super().__init__()
        self.tables = []
        self._table = None
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table = {"headers": [], "rows": []}
        elif tag == "tr" and self._table is not None:
            self._row = []
            self._row_is_header = False
        elif tag == "th" and self._row is not None:
            self._cell = ""
            self._row_is_header = True
        elif tag == "td" and self._row is not None:
            self._cell = ""

    def handle_data(self, data):
        if self._cell is not None:
            self._cell += data

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self._cell is not None:
            self._row.append(self._cell.strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if getattr(self, "_row_is_header", False):
                self._table["headers"] = self._row
            elif self._row:
                self._table["rows"].append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None


def fetch_tickers(url, want_header):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        html = r.read().decode("utf-8", "replace")
    parser = TableParser()
    parser.feed(html)
    for table in parser.tables:
        headers = [h.strip() for h in table["headers"]]
        if want_header not in headers:
            continue
        col = headers.index(want_header)
        tickers = []
        for row in table["rows"]:
            if col < len(row):
                # Ticker is the first token (cells may carry footnote markers).
                token = row[col].split()[0] if row[col].split() else ""
                if token:
                    tickers.append(token)
        if len(tickers) >= 50:
            return tickers
    raise SystemExit(f"no {want_header!r} table with >=50 rows at {url}")


def write_ts(name, const, tickers, url):
    today = datetime.date.today().isoformat()
    lines = [
        f"// {name} constituent tickers, snapshot {today} from {url}.",
        "// Re-run backend/scripts/fetch_constituents.py to refresh.",
        f"export const {const}: string[] = [",
    ]
    lines += [f'  "{t}",' for t in tickers]
    lines.append("];\n")
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{name}.ts")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def main():
    for name, (url, const, header) in SOURCES.items():
        tickers = fetch_tickers(url, header)
        # De-dupe while preserving order (e.g. multi-class listings share rows).
        seen, unique = set(), []
        for t in tickers:
            if t not in seen:
                seen.add(t)
                unique.append(t)
        path = write_ts(name, const, unique, url)
        print(f"{name}: {len(unique)} tickers -> {path}")
        print(f"  sample: {unique[:5]}")


if __name__ == "__main__":
    main()
