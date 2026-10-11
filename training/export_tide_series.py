"""
Xuất chuỗi triều tính sẵn để Node dùng — thay vì Node tự tái tạo từ hệ số.

Lý do: quy ước pha của utide là pha Greenwich theo thời gian thiên văn, kèm
hiệu chỉnh nút mặt trăng (nodal corrections) thay đổi theo thời điểm. Tôi đã
thử tự viết `A·cos(2πft − g)` phía Node và sai tới 6 m — gần như ngược pha.

Thay vì đoán tiếp, để utide (thư viện đã kiểm chứng) tính sẵn chuỗi triều rồi
Node chỉ nội suy tuyến tính giữa hai mốc 15 phút. Sai số nội suy trên chuỗi
15 phút của triều 12.4h là dưới 1 cm — nhỏ hơn nhiều so với residual stdev
0.19 m, nên không ảnh hưởng gì.

Seeder chạy 15 phút/lần và chỉ cần triều cho 6h tới, nên một file phủ vài
tháng là quá đủ; cron train lại định kỳ sẽ làm mới.
"""

import argparse
import csv
import glob
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import utide

REPO = Path(__file__).resolve().parents[1]
MEASURE = 'E70124-level-tidal_level-Mean-15_min-m'
LAT = 53.44967


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--raw-dir', default='/tmp/coastal-training/raw')
    ap.add_argument('--station', default='liverpool-gladstone')
    ap.add_argument('--days-ahead', type=int, default=120)
    ap.add_argument('--days-back', type=int, default=40)
    ap.add_argument('--out', default='training/models')
    args = ap.parse_args()

    rows = []
    for f in sorted(Path(args.raw_dir).glob('*.csv')):
        for r in csv.reader(f.open()):
            if len(r) >= 3 and MEASURE in r[1]:
                try:
                    t = datetime.fromisoformat(r[0].replace('Z', '+00:00'))
                    rows.append((t, float(r[2])))
                except ValueError:
                    continue
    rows.sort()
    T = np.array([np.datetime64(t.replace(tzinfo=None), 's') for t, _ in rows])
    L = np.array([v for _, v in rows])

    print(f'khớp điều hoà trên {len(rows)} điểm...')
    coef = utide.solve(T, L, lat=LAT, method='ols', conf_int='none', verbose=False)
    fitted = utide.reconstruct(T, coef, verbose=False).h
    res = L - fitted
    var_exp = 1 - np.var(res) / np.var(L)
    print(f'phương sai giải thích: {var_exp*100:.2f}% | residual stdev {res.std():.4f} m')
    if var_exp < 0.9:
        raise SystemExit(f'FATAL: khớp kém ({var_exp*100:.2f}%), từ chối xuất')

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now - timedelta(days=args.days_back)
    end = now + timedelta(days=args.days_ahead)
    steps = int((end - start).total_seconds() // 900) + 1
    grid = [start + timedelta(minutes=15 * i) for i in range(steps)]
    gT = np.array([np.datetime64(t.replace(tzinfo=None), 's') for t in grid])
    tide = utide.reconstruct(gT, coef, verbose=False).h

    clean = res[np.abs(res) <= 1.5]
    out = {
        'stationId': args.station,
        'method': 'utide-precomputed-series',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'varianceExplained': float(var_exp),
        'residualStd': float(clean.std()),
        'startMs': int(grid[0].timestamp() * 1000),
        'stepMs': 900_000,
        'count': len(tide),
        'coverageFrom': grid[0].isoformat(),
        'coverageTo': grid[-1].isoformat(),
        # Làm tròn mm: triều đo bằng mét, giữ thêm chữ số chỉ phình file.
        'values': [round(float(v), 3) for v in tide],
        'caveats': [
            'Triều suy ra từ quan trắc tại trạm bằng phân tích điều hoà, '
            'KHÔNG phải số liệu chính thức UKHO/Admiralty. Không dùng cho hàng hải.',
            f'Chuỗi khớp {(rows[-1][0]-rows[0][0]).days} ngày (<1 năm): '
            'thành phần chu kỳ năm (SA/SSA) kém tin cậy.',
            'Chuỗi tính trước có hạn dùng — hết coverageTo phải chạy lại script này.',
        ],
    }
    p = REPO / args.out / f'{args.station}.tide.json'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    print(f'đã ghi {p} ({p.stat().st_size/1024:.0f} KB, {len(tide)} mốc, '
          f'{grid[0]:%Y-%m-%d} -> {grid[-1]:%Y-%m-%d})')

    # Mốc kiểm chứng để Node đối chiếu.
    for h in (0, 4, 8, 11, 14, 18):
        t = now.replace(hour=h) if h < 24 else now
        i = int((t - grid[0]).total_seconds() // 900)
        if 0 <= i < len(tide):
            print(f'  {t:%Y-%m-%dT%H:%M}Z -> {tide[i]:.3f} m')


if __name__ == '__main__':
    main()
