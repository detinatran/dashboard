"""
Build the Liverpool training dataset from the Environment Agency daily archive.

Two rules govern this file:

  1. Features are NOT computed here. They come from
     `scripts/shared/coastal-features.mjs` via a Node subprocess, so training and
     production share one implementation. A Python reimplementation would drift,
     and the drift would be invisible until predictions were already wrong.

  2. Targets are read strictly forward of the base timestamp; features strictly
     backward. The split is chronological, never shuffled.
"""

import argparse
import csv
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
FEATURE_BRIDGE = REPO / "training" / "feature_builder" / "bridge.mjs"
HORIZONS = (1, 3, 6)
STEP_MIN = 15


def load_levels(raw_dir: Path, measure: str):
    """Read the pre-filtered daily CSVs into a {timestamp_ms: level} map."""
    series = {}
    for path in sorted(raw_dir.glob("*.csv")):
        with path.open() as fh:
            for row in csv.reader(fh):
                if len(row) < 3:
                    continue
                dt, m, val = row[0], ",".join(row[1:-1]), row[-1]
                if measure not in m:
                    continue
                try:
                    ts = int(datetime.fromisoformat(dt.replace("Z", "+00:00")).timestamp() * 1000)
                    series[ts] = float(val)
                except ValueError:
                    continue
    return dict(sorted(series.items()))


def load_weather(path: Path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    out = {}
    for i, iso in enumerate(times):
        try:
            ts = int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            continue

        def g(key):
            arr = hourly.get(key) or []
            v = arr[i] if i < len(arr) else None
            return v if isinstance(v, (int, float)) else None

        out[ts] = {
            "ts": ts,
            "pressure": g("pressure_msl"),
            "windSpeed": g("wind_speed_10m"),
            "windDirection": g("wind_direction_10m"),
            "windGust": g("wind_gusts_10m"),
            "precipitation": g("precipitation"),
            "temperature": g("temperature_2m"),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", default="/tmp/coastal-training/raw")
    ap.add_argument("--weather", default="/tmp/coastal-training/weather.json")
    ap.add_argument("--measure", default="E70124-level-tidal_level-Mean-15_min-m")
    ap.add_argument("--out", default="training/data/liverpool.npz")
    args = ap.parse_args()

    raw_dir = Path(args.raw_dir)
    levels = load_levels(raw_dir, args.measure)
    if not levels:
        print(f"FATAL: no level rows under {raw_dir}", file=sys.stderr)
        sys.exit(1)

    weather = load_weather(Path(args.weather))
    ts_all = list(levels.keys())
    print(f"levels: {len(ts_all)} samples "
          f"{datetime.fromtimestamp(ts_all[0]/1000, timezone.utc):%Y-%m-%d} .. "
          f"{datetime.fromtimestamp(ts_all[-1]/1000, timezone.utc):%Y-%m-%d}")
    print(f"weather: {len(weather)} hourly rows")

    # Candidate base times: need 24h of history behind and 6h of truth ahead.
    step_ms = STEP_MIN * 60_000
    hist_ms = 24 * 3_600_000
    horizon_ms = max(HORIZONS) * 3_600_000
    level_at = levels

    bases = [t for t in ts_all
             if (t - hist_ms) >= ts_all[0]
             and (t + horizon_ms) <= ts_all[-1]]
    print(f"candidate base times: {len(bases)}")

    # Hand the whole job to Node once: per-sample subprocess calls would take hours.
    payload = {
        "levels": [{"ts": t, "level": v} for t, v in levels.items()],
        "weather": list(weather.values()),
        "bases": bases,
        "horizons": list(HORIZONS),
        "stepMs": step_ms,
    }
    proc = subprocess.run(
        ["node", str(FEATURE_BRIDGE)],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print("FATAL: feature bridge failed", file=sys.stderr)
        print(proc.stderr[-4000:], file=sys.stderr)
        sys.exit(1)
    built = json.loads(proc.stdout)

    X = np.array(built["X"], dtype=np.float32)
    base_ts = np.array(built["baseTs"], dtype=np.int64)
    names = built["featureNames"]
    print(f"feature matrix: {X.shape} (version {built['featureVersion']})")
    if len(built.get("skipped", {})):
        print("skipped:", json.dumps(built["skipped"]))

    # Targets: the observed level exactly h hours after each base time.
    # Strictly forward, and only where a real observation exists.
    ys, masks = {}, {}
    for h in HORIZONS:
        off = h * 3_600_000
        y = np.full(len(base_ts), np.nan, dtype=np.float32)
        for i, t in enumerate(base_ts):
            v = level_at.get(int(t) + off)
            if v is not None:
                y[i] = v
        ys[h] = y
        masks[h] = ~np.isnan(y)
        print(f"  +{h}h targets: {int(masks[h].sum())}/{len(y)} present")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out, X=X, base_ts=base_ts,
        y1=ys[1], y3=ys[3], y6=ys[6],
        m1=masks[1], m3=masks[3], m6=masks[6],
        feature_names=np.array(names),
        feature_version=built["featureVersion"],
    )
    print(f"wrote {out} ({out.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
