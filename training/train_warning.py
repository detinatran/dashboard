"""
Train mô hình cảnh báo kiểu TideWISE cho Liverpool.

=====================================================================
KẾT QUẢ: CHƯA TRIỂN KHAI ĐƯỢC VỚI DỮ LIỆU HIỆN CÓ (2026-09-14)
=====================================================================
Đã chạy và đã thử ba cách chia tập. Không cách nào cho mô hình dùng được:

  chia thời gian 70/15/15      test có 0 mẫu dương  -> không đánh giá được
  đông 2025 -> đông/xuân 2026  AUPRC 0.064, precision 0.00, recall 0.00
  bỏ mùa hè, chia 75/25        AUPRC 0.042, precision 0.00, recall 0.00

AUPRC cao hơn ngẫu nhiên ~8x nghe có vẻ khá, nhưng precision và recall đều
bằng 0: ở mọi ngưỡng hữu dụng mô hình không bắt được sự kiện nào. Một mô hình
cảnh báo bỏ sót 100% sự kiện thì tệ hơn là không có, vì nó tạo cảm giác an
toàn giả.

NGUYÊN NHÂN — là giới hạn dữ liệu, không phải lỗi thuật toán:
  * Chuỗi 362 ngày, chưa trọn một chu kỳ mùa.
  * Sự kiện nước dâng dồn vào mùa đông (10/2025: 5.11%, 12/2025: 2.79%),
    còn 05, 06, 08/2026 = 0.00%.
  * Tỷ lệ mẫu dương ~0.7%; chia theo thời gian kiểu nào cũng để một phía
    thiếu sự kiện.

CẦN GÌ ĐỂ LÀM ĐƯỢC: tối thiểu 3-5 năm quan trắc để mỗi tập chứa nhiều mùa
bão. EA có kho lưu trữ nhưng chỉ phát hành ~1 năm gần nhất qua endpoint này.

Cho tới lúc đó, hệ thống trả `model_not_configured` và giao diện nói rõ
"Warning model not available for this site" — đúng như thiết kế. KHÔNG được
hạ ngưỡng hay đổi cách gán nhãn để ép ra một con số đẹp.


Khác hẳn mô hình hồi quy mực nước: đây là BÀI TOÁN PHÂN LOẠI, trả lời
"trong h giờ tới có khả năng xuất hiện residual bất thường không?".

Nhãn gán theo kiểu giám sát yếu (weak supervision) của TideWISE:
    R_plus(t,h) = max(residual(t), ..., residual(t+h))
    nhãn = 1 nếu R_plus >= ngưỡng phân vị cao của giai đoạn train

CỰC KỲ QUAN TRỌNG: thông tin tương lai CHỈ được dùng để tạo nhãn offline.
Nó KHÔNG BAO GIỜ đi vào đặc trưng lúc suy luận — feature vector vẫn do
scripts/shared/coastal-features.mjs dựng, và bộ test rò rỉ đã chứng minh
nó không đọc bất kỳ mẫu nào sau thời điểm t.

Outlier: chuỗi có vài điểm cảm biến hỏng (1 điểm residual -5.17 m trong khi
stdev chỉ 0.19 m). Nếu không lọc, một điểm hỏng sẽ thành "sự kiện cực đoan"
và dạy mô hình học nhiễu.
"""

import argparse
import csv
import glob
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, f1_score, precision_score,
                             recall_score, roc_auc_score)

REPO = Path(__file__).resolve().parents[1]
MEASURE = 'E70124-level-tidal_level-Mean-15_min-m'
HORIZONS = (1, 3, 6)
MODEL_VERSION = 'liverpool-tidewise-v1'
OUTLIER_ABS_M = 1.5   # |residual| lớn hơn ngưỡng này là lỗi cảm biến, không phải nước dâng


def load_residuals(raw_dir: Path, tide_path: Path):
    import utide
    rows = []
    for f in sorted(raw_dir.glob('*.csv')):
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
    coef = utide.solve(T, L, lat=53.44967, method='ols', conf_int='none', verbose=False)
    tide = utide.reconstruct(T, coef, verbose=False).h
    res = L - tide
    ts_ms = np.array([int(t.timestamp() * 1000) for t, _ in rows])
    return ts_ms, res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='training/data/liverpool.npz')
    ap.add_argument('--raw-dir', default='/tmp/coastal-training/raw')
    ap.add_argument('--tide', default='training/models/liverpool-gladstone.tide.json')
    ap.add_argument('--station', default='liverpool-gladstone')
    ap.add_argument('--out', default='training/models')
    args = ap.parse_args()

    d = np.load(REPO / args.data, allow_pickle=True)
    X, base_ts = d['X'], d['base_ts']
    order = np.argsort(base_ts)
    X, base_ts = X[order], base_ts[order]
    feature_names = [str(x) for x in d['feature_names']]
    feature_version = str(d['feature_version'])

    ts_ms, res = load_residuals(Path(args.raw_dir), REPO / args.tide)

    # Lọc outlier TRƯỚC khi gán nhãn.
    bad = np.abs(res) > OUTLIER_ABS_M
    print(f'lọc outlier |residual| > {OUTLIER_ABS_M} m: {int(bad.sum())} điểm '
          f'({bad.mean()*100:.4f}%)')
    res_clean = res.copy()
    res_clean[bad] = np.nan

    res_at = dict(zip(ts_ms.tolist(), res_clean.tolist()))
    step = 15 * 60_000

    report = {
        'modelVersion': MODEL_VERSION,
        'featureVersion': feature_version,
        'expectedFeatureCount': int(X.shape[1]),
        'stationId': args.station,
        'trainedAt': datetime.now(timezone.utc).isoformat(),
        'labelling': 'tidewise-weak-supervision (max future residual >= train-period quantile)',
        'outlierFilterAbsM': OUTLIER_ABS_M,
        'horizons': {},
        'warningThreshold': {},
        'featureNames': feature_names,
        'split': {'method': 'chronological', 'trainFrac': 0.70, 'valFrac': 0.15, 'testFrac': 0.15},
    }

    try:
        from skl2onnx import to_onnx
        from skl2onnx.common.data_types import FloatTensorType
    except ImportError:
        raise SystemExit('FATAL: thiếu skl2onnx')

    out_dir = REPO / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    for h in HORIZONS:
        steps = h * 4  # 15 phút mỗi bước
        y = np.full(len(base_ts), np.nan)
        for i, t in enumerate(base_ts):
            vals = [res_at.get(int(t) + k * step) for k in range(1, steps + 1)]
            vals = [v for v in vals if v is not None and not np.isnan(v)]
            # Cần phần lớn cửa sổ tương lai mới gán nhãn được.
            if len(vals) >= steps * 0.8:
                y[i] = max(vals)
        mask = ~np.isnan(y)
        Xh, yh_raw, tsh = X[mask], y[mask], base_ts[mask]

        tr_end = int(len(yh_raw) * 0.70)
        va_end = int(len(yh_raw) * 0.85)
        # Ngưỡng lấy TỪ GIAI ĐOẠN TRAIN, không phải toàn bộ — dùng cả chuỗi là rò rỉ.
        thr = float(np.percentile(yh_raw[:tr_end], 99))
        yh = (yh_raw >= thr).astype(int)

        pos = int(yh.sum())
        print(f'\n+{h}h  mẫu={len(yh)}  ngưỡng residual={thr:.3f} m  dương={pos} ({pos/len(yh)*100:.2f}%)')
        if pos < 40:
            print(f'      quá ít mẫu dương ({pos}) — bỏ qua horizon này')
            continue

        tr, va, te = slice(0, tr_end), slice(tr_end, va_end), slice(va_end, len(yh))
        clf = HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.06, min_samples_leaf=30,
            l2_regularization=1.0, class_weight='balanced', random_state=0,
        )
        clf.fit(Xh[tr], yh[tr])

        pv = clf.predict_proba(Xh[va])[:, 1]
        # Chọn ngưỡng xác suất tối ưu F1 trên tập VAL, không phải test.
        best_t, best_f1 = 0.5, -1.0
        for cand in np.linspace(0.05, 0.95, 91):
            f1 = f1_score(yh[va], (pv >= cand).astype(int), zero_division=0)
            if f1 > best_f1:
                best_f1, best_t = f1, float(cand)

        pt = clf.predict_proba(Xh[te])[:, 1]
        pred = (pt >= best_t).astype(int)
        tp = int(((pred == 1) & (yh[te] == 1)).sum())
        fp = int(((pred == 1) & (yh[te] == 0)).sum())
        far = fp / (tp + fp) if (tp + fp) else 0.0

        m = {
            'auprc': float(average_precision_score(yh[te], pt)),
            'rocauc': float(roc_auc_score(yh[te], pt)) if len(set(yh[te].tolist())) > 1 else None,
            'precision': float(precision_score(yh[te], pred, zero_division=0)),
            'recall': float(recall_score(yh[te], pred, zero_division=0)),
            'f1': float(f1_score(yh[te], pred, zero_division=0)),
            'falseAlarmRatio': float(far),
            'positives': int(yh[te].sum()),
            'n': int(len(pred)),
        }
        print(f"      TEST AUPRC={m['auprc']:.3f} P={m['precision']:.3f} R={m['recall']:.3f} "
              f"F1={m['f1']:.3f} FAR={m['falseAlarmRatio']:.3f} (dương={m['positives']}/{m['n']})")

        report['horizons'][str(h)] = {'test': m, 'residualThresholdM': thr,
                                      'probThreshold': best_t, 'valF1': float(best_f1)}
        report['warningThreshold'][str(h)] = best_t

        onx = to_onnx(clf, initial_types=[('input', FloatTensorType([None, X.shape[1]]))],
                      target_opset=17, options={id(clf): {'zipmap': False}})
        p = out_dir / f'{args.station}.warn.h{h}.onnx'
        p.write_bytes(onx.SerializeToString())
        print(f'      đã xuất {p.name} ({p.stat().st_size/1024:.0f} KB)')

    if not report['horizons']:
        raise SystemExit('FATAL: không horizon nào train được')

    meta = out_dir / f'{args.station}.warn.meta.json'
    meta.write_text(json.dumps(report, indent=2))
    print(f'\nđã ghi {meta}')


if __name__ == '__main__':
    main()
