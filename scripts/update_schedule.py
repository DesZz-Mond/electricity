#!/usr/bin/env python3
"""Fetch the public Kirovohrad region schedule page and safely update schedule.json.

The script deliberately fails closed: if the source layout cannot be parsed, it exits
with an error and does not replace the last-known valid file with fabricated data.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "schedule.json"
SOURCE_URL = "https://svitlo.live/kirovogradska-oblast"
OFFICIAL_URL = "https://kiroe.com.ua/electricity-blackout"
QUEUES = [f"{main}.{sub}" for main in range(1, 7) for sub in (1, 2)]


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def get_cell_signals(cell: Tag) -> str:
    signals: list[str] = [cell.get_text(" ", strip=True)]
    for tag in [cell, *cell.find_all(True)]:
        for key in ("aria-label", "title", "alt", "data-status", "data-state", "class"):
            value = tag.get(key)
            if isinstance(value, list):
                signals.extend(str(item) for item in value)
            elif value:
                signals.append(str(value))
    return " ".join(signals).strip().casefold()


def status_for_cell(cell: Tag) -> str:
    signal = get_cell_signals(cell)
    # Prefer the explicit "possible outage" marker before general words.
    if "±" in signal or "можливе відключення" in signal or "possible" in signal:
        return "possible"
    if any(token in signal for token in ("✕", "×", "відсутнє", "світла немає", "power-off", "status-off", "blackout")):
        return "off"
    if "●" in signal or "світло є" in signal or "power-on" in signal or "status-on" in signal or "powered" in signal:
        return "on"
    # Some renderers use a short class token for a colored state.
    classes = set(signal.split())
    if classes.intersection({"off", "outage", "no-power", "no_power"}):
        return "off"
    if classes.intersection({"on", "power", "available", "has-power"}):
        return "on"
    return "unknown"


def parse_source_date(table: Tag) -> str | None:
    match = re.search(r"\b(\d{2})\.(\d{2})\.(\d{4})\b", table.get_text(" ", strip=True))
    if not match:
        return None
    day, month, year = map(int, match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None


def next_table_after_heading(heading: Tag) -> Tag | None:
    # Do not accidentally grab a later section's table if this heading has no table.
    for element in heading.find_all_next(["h1", "h2", "h3", "h4", "table"]):
        if element.name == "table":
            return element
        if element is not heading:
            return None
    return None


def parse_hours(table: Tag) -> list[str] | None:
    candidate_rows: list[list[Tag]] = []
    for row in table.find_all("tr"):
        cells = row.find_all(["td", "th"], recursive=False)
        if not cells:
            cells = row.find_all(["td", "th"])
        if len(cells) >= 24:
            candidate_rows.append(cells)
    if not candidate_rows:
        return None

    # On the source page the status row follows the row of hourly labels and has
    # either 24 cells or a queue-name cell plus 24 hourly state cells.
    cells = candidate_rows[-1]
    cells = cells[-24:]
    if len(cells) != 24:
        return None
    return [status_for_cell(cell) for cell in cells]


def parse_schedule(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    parsed: dict[str, dict[str, Any]] = {
        "today": {"date": None, "queues": {}},
        "tomorrow": {"date": None, "queues": {}},
    }
    observed_dates: dict[str, set[str]] = {"today": set(), "tomorrow": set()}
    headings = soup.find_all(["h2", "h3", "h4"])
    for heading in headings:
        heading_text = normalize_text(heading.get_text(" ", strip=True))
        match = re.search(r"графік\s+на\s+(сьогодні|завтра)\s*[-—:]\s*черга\s*(\d\.\d)", heading_text, re.IGNORECASE)
        if not match:
            continue
        day_key = "today" if match.group(1).casefold() == "сьогодні" else "tomorrow"
        queue = match.group(2)
        table = next_table_after_heading(heading)
        if table is None:
            continue
        hours = parse_hours(table)
        source_date = parse_source_date(table)
        if hours is None or not source_date:
            continue
        parsed[day_key]["queues"][queue] = hours
        observed_dates[day_key].add(source_date)
        # Queue tables for a day should share one date. Keep the first valid date.
        if parsed[day_key]["date"] is None:
            parsed[day_key]["date"] = source_date

    missing: list[str] = []
    for day_key in ("today", "tomorrow"):
        if not parsed[day_key]["date"]:
            missing.append(f"{day_key}: date")
        for queue in QUEUES:
            if queue not in parsed[day_key]["queues"]:
                missing.append(f"{day_key}: queue {queue}")
    if missing:
        raise ValueError(
            "Could not parse a complete schedule from the public source. Missing: "
            + ", ".join(missing[:12])
            + (" …" if len(missing) > 12 else "")
        )

    # Do not let an inconsistent mix of cached dates pass as one coherent schedule.
    for day_key in ("today", "tomorrow"):
        if len(observed_dates[day_key]) != 1:
            raise ValueError(f"The source returned inconsistent dates for {day_key}: {sorted(observed_dates[day_key])}.")

    return parsed


def load_previous() -> dict[str, Any] | None:
    if not OUTPUT.exists():
        return None
    try:
        value = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def main() -> int:
    headers = {
        "User-Agent": "SvitloPoruchScheduleBot/1.0 (+static GitHub Pages community schedule view)",
        "Accept": "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    try:
        response = requests.get(SOURCE_URL, headers=headers, timeout=35, params={"refresh": int(datetime.now().timestamp())})
        response.raise_for_status()
        response.encoding = response.apparent_encoding or response.encoding
        days = parse_schedule(response.text)
    except Exception as error:  # keep the valid prior data if the upstream page is unavailable
        print(f"ERROR: schedule update failed safely: {error}", file=sys.stderr)
        return 1

    old = load_previous()
    next_payload: dict[str, Any] = {
        "schemaVersion": 1,
        "source": {
            "name": "Svitlo.live",
            "url": SOURCE_URL,
            "officialUrl": OFFICIAL_URL,
        },
        "updatedAt": None,
        "days": days,
    }
    # Avoid a noisy repository commit every 10 minutes if the schedule is unchanged.
    if old and old.get("days") == next_payload["days"] and old.get("source") == next_payload["source"]:
        next_payload["updatedAt"] = old.get("updatedAt")
    else:
        next_payload["updatedAt"] = utc_now()

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(next_payload, ensure_ascii=False, indent=2) + "\n"
    old_text = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else None
    if old_text != serialized:
        OUTPUT.write_text(serialized, encoding="utf-8")
        print("Schedule data changed; wrote data/schedule.json")
    else:
        print("Schedule is unchanged; no repository update needed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
