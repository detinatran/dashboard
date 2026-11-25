"""
Harmonic tide analysis for Liverpool.

The astronomical tide is a sum of sine waves with periods set by the Earth,
Moon and Sun (M2 = 12.42h, S2 = 12h, K1, O1, ...). utide estimates the
amplitude and phase of each one from the observations and can then rebuild the
tide for any time, including the future.

Limitations:
  * The series covers 362 days (0.99 years). The semidiurnal and diurnal
    constituents are solid; the annual ones (SA, SSA) don't get a full cycle,
    so they're less reliable.
  * This is derived from this station's own data, not official UKHO/Admiralty
    predictions.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import utide

from _ea_archive import LAT, load_tidal_rows

REPO = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-dir', default='/tmp/coastal-training/raw')
    ap.add_argument('--out', default='training/models/liverpool-gladstone.tide.json')
    args = ap.parse_args()

    rows = load_tidal_rows(Path(args.raw_dir))
    if len(rows) < 2000:
        raise SystemExit(f'FATAL: chỉ có {len(rows)} điểm, quá ít để phân tích điều hoà')

    # Pass np.datetime64 straight to utide. An earlier version converted to datenum
    # with `timestamp/86400 + 719163`, the time axis was off, every tidal frequency
    # went out of phase and the fit explained just 0.04% of the variance.
    times = np.array([np.datetime64(r[0].replace(tzinfo=None), 's') for r in rows])
    levels = np.array([r[1] for r in rows])
    span_days = (rows[-1][0] - rows[0][0]).days

    print(f'điểm: {len(rows)} | {rows[0][0]:%Y-%m-%d} -> {rows[-1][0]:%Y-%m-%d} ({span_days} ngày)')
    print('đang phân tích điều hoà (utide)...')

    coef = utide.solve(
        times, levels,
        lat=LAT,
        method='ols',
        conf_int='MC',
        verbose=False,
    )

    # Reconstruct the tide over the observed series itself to measure fit quality.
    recon = utide.reconstruct(times, coef, verbose=False)
    tide = recon.h
    residual = levels - tide

    var_explained = 1 - np.var(residual) / np.var(levels)
    print(f'\nphương sai giải thích bởi triều: {var_explained*100:.2f}%')
    print(f'residual: trung bình {residual.mean():+.4f} m, độ lệch chuẩn {residual.std():.4f} m')
    print(f'residual: min {residual.min():+.3f} m, max {residual.max():+.3f} m')

    # Warning thresholds from high residual percentiles (TideWISE-style weak labels).
    q99 = float(np.percentile(residual, 99))
    q995 = float(np.percentile(residual, 99.5))
    print(f'phân vị residual: 99% = {q99:.3f} m | 99.5% = {q995:.3f} m')

    # The 8 strongest constituents, for the report.
    order = np.argsort(coef['A'])[::-1][:8]
    print('\nthành phần triều mạnh nhất:')
    for i in order:
        print(f"  {coef['name'][i]:<6} biên độ {coef['A'][i]:.3f} m  pha {coef['g'][i]:7.2f}°")

    out = {
        'stationId': 'liverpool-gladstone',
        'method': 'utide-harmonic-ols',
        'fittedAt': datetime.now(timezone.utc).isoformat(),
        'lat': LAT,
        'spanDays': span_days,
        'sampleCount': len(rows),
        'varianceExplained': float(var_explained),
        'residualStd': float(residual.std()),
        'residualMean': float(residual.mean()),
        'thresholds': {'p99': q99, 'p995': q995},
        # Coefficients for reconstructing the tide on the Node side.
        'constituents': [
            {'name': str(coef['name'][i]), 'amplitude': float(coef['A'][i]),
             'phase_deg': float(coef['g'][i]), 'frequency_cph': float(coef['aux']['frq'][i])}
            for i in range(len(coef['name']))
        ],
        'mean': float(coef['mean']),
        'slope': float(coef.get('slope', 0.0)),
        'referenceEpoch': rows[0][0].isoformat(),
        'caveats': [
            f'Chuỗi {span_days} ngày (<1 năm): thành phần chu kỳ năm (SA/SSA) kém tin cậy.',
            'Triều suy ra từ quan trắc tại trạm, KHÔNG phải số liệu chính thức UKHO/Admiralty.',
        ],
    }
    p = REPO / args.out
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, indent=2))
    print(f'\nđã ghi {p} ({len(out["constituents"])} thành phần)')


if __name__ == '__main__':
    main()
