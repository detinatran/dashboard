"""
Reads the Environment Agency daily CSV dumps for the Liverpool gauge.

fit_tide.py, export_tide_series.py and train_warning.py all load the same
files, so the parsing lives here once.
"""

import csv
from datetime import datetime
from pathlib import Path

# Liverpool (Gladstone Dock), 15-min mean in metres on the local gauge datum.
MEASURE = 'E70124-level-tidal_level-Mean-15_min-m'
LAT = 53.44967


def load_tidal_rows(raw_dir: Path):
    """Returns [(datetime_utc, level_m), ...] for MEASURE, sorted by time."""
    rows = []
    for path in sorted(raw_dir.glob('*.csv')):
        with path.open() as fh:
            for r in csv.reader(fh):
                if len(r) >= 3 and MEASURE in r[1]:
                    try:
                        t = datetime.fromisoformat(r[0].replace('Z', '+00:00'))
                        rows.append((t, float(r[2])))
                    except ValueError:
                        continue
    rows.sort()
    return rows
