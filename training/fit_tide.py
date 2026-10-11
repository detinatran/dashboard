"""
Phân tích điều hoà triều (harmonic analysis) cho Liverpool.

Triều thiên văn KHÔNG phải thứ bịa ra: nó là tổng các dao động hình sin có chu
kỳ do chuyển động Trái Đất–Mặt Trăng–Mặt Trời quyết định (M2 = 12.42h, S2 = 12h,
K1, O1, ...). utide ước lượng biên độ + pha của từng thành phần từ chuỗi quan
trắc, rồi tái tạo triều cho bất kỳ thời điểm nào — kể cả tương lai.

QUAN TRỌNG — giới hạn phải ghi rõ, không được lờ:
  * Chuỗi dài 362 ngày (0.99 năm). Các thành phần bán nhật/nhật rất tin cậy;
    riêng thành phần chu kỳ năm (SA, SSA) chưa trọn một chu kỳ nên kém chắc.
  * Đây là triều THIÊN VĂN suy ra từ quan trắc tại chính trạm này, không phải
    số liệu chính thức của UKHO/Admiralty.
"""

import argparse
import csv
import glob
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import utide

REPO = Path(__file__).resolve().parents[1]
MEASURE = 'E70124-level-tidal_level-Mean-15_min-m'
LAT = 53.44967


def load(raw_dir: Path):
    rows = []
    for f in sorted(raw_dir.glob('*.csv')):
        for r in csv.reader(f.open()):
            if len(r) >= 3 and MEASURE in r[1]:
                try:
                    ts = datetime.fromisoformat(r[0].replace('Z', '+00:00'))
                    rows.append((ts, float(r[2])))
                except ValueError:
                    continue
    rows.sort()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-dir', default='/tmp/coastal-training/raw')
    ap.add_argument('--out', default='training/models/liverpool-gladstone.tide.json')
    args = ap.parse_args()

    rows = load(Path(args.raw_dir))
    if len(rows) < 2000:
        raise SystemExit(f'FATAL: chỉ có {len(rows)} điểm, quá ít để phân tích điều hoà')

    # utide nhận thẳng np.datetime64 — KHÔNG tự quy đổi datenum bằng hằng số
    # nhớ áng chừng. Lần trước tôi dùng `timestamp/86400 + 719163` và trục thời
    # gian lệch, khiến mọi tần số triều lệch pha: kết quả ra 0 thành phần và
    # chỉ giải thích 0.04% phương sai.
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

    # Tái tạo triều trên chính chuỗi quan trắc để đo chất lượng.
    recon = utide.reconstruct(times, coef, verbose=False)
    tide = recon.h
    residual = levels - tide

    var_explained = 1 - np.var(residual) / np.var(levels)
    print(f'\nphương sai giải thích bởi triều: {var_explained*100:.2f}%')
    print(f'residual: trung bình {residual.mean():+.4f} m, độ lệch chuẩn {residual.std():.4f} m')
    print(f'residual: min {residual.min():+.3f} m, max {residual.max():+.3f} m')

    # Ngưỡng cảnh báo theo phân vị cao (cách TideWISE gán nhãn yếu).
    q99 = float(np.percentile(residual, 99))
    q995 = float(np.percentile(residual, 99.5))
    print(f'phân vị residual: 99% = {q99:.3f} m | 99.5% = {q995:.3f} m')

    # 8 thành phần mạnh nhất, để báo cáo.
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
        # Hệ số để tái tạo triều ở phía Node.
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
