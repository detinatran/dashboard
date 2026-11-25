"""
Trains a TideWISE-style warning model for Liverpool.

Status (2026-09-14): not usable yet with the data we have.

Tried three different splits, none of them gave a usable model:

  chronological 70/15/15        0 positives in test  -> cannot be evaluated
  winter 2025 -> winter/spring 2026  AUPRC 0.064, precision 0.00, recall 0.00
  summer dropped, 75/25 split   AUPRC 0.042, precision 0.00, recall 0.00

AUPRC ~8x above random sounds OK, but precision and recall are both 0, so at
any useful threshold it catches nothing. A warning model that misses every
event is worse than no model, since people would trust it.

Why: not enough data, rather than a bug in the method.
  * The series spans 362 days, less than one full seasonal cycle.
  * Surge events cluster in winter (10/2025: 5.11%, 12/2025: 2.79%), while
    05, 06 and 08/2026 are 0.00%.
  * Positive rate is ~0.7%; any chronological split leaves one side short of
    events.

What we'd need: at least 3-5 years of data so each split has a few storm
seasons. EA has an archive but this endpoint only gives about the last year.

Until then the seeder returns `model_not_configured` and the UI shows "Warning
model not available for this site", which is what we want. Don't lower the
threshold or change the labels just to get a nicer number.


Unlike the water-level regression this is a classification problem: "is an
unusual residual likely in the next h hours?"

Labels follow TideWISE's weak supervision:
    R_plus(t,h) = max(residual(t), ..., residual(t+h))
    label = 1 if R_plus >= a high percentile of the training period

Future values are only used to build the labels offline. They never go into
the features: those still come from scripts/shared/coastal-features.mjs, and
the leakage tests check it reads nothing after time t.

Outliers: there are a few bad sensor readings (one residual of -5.17 m with a
0.19 m stdev). Left in, a single bad point becomes an "extreme event" and the
model learns noise.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, f1_score, precision_score,
                             recall_score, roc_auc_score)

from _ea_archive import LAT, load_tidal_rows

REPO = Path(__file__).resolve().parents[1]
HORIZONS = (1, 3, 6)
MODEL_VERSION = 'liverpool-tidewise-v1'
OUTLIER_ABS_M = 1.5   # |residual| above this is a sensor fault, not a surge


def load_residuals(raw_dir: Path, tide_path: Path):
    import utide
    rows = load_tidal_rows(raw_dir)
    T = np.array([np.datetime64(t.replace(tzinfo=None), 's') for t, _ in rows])
    L = np.array([v for _, v in rows])
    coef = utide.solve(T, L, lat=LAT, method='ols', conf_int='none', verbose=False)
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

    # Drop outliers before labelling.
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
        steps = h * 4  # 15 minutes per step
        y = np.full(len(base_ts), np.nan)
        for i, t in enumerate(base_ts):
            vals = [res_at.get(int(t) + k * step) for k in range(1, steps + 1)]
            vals = [v for v in vals if v is not None and not np.isnan(v)]
            # Only label when most of the future window is present.
            if len(vals) >= steps * 0.8:
                y[i] = max(vals)
        mask = ~np.isnan(y)
        Xh, yh_raw, tsh = X[mask], y[mask], base_ts[mask]

        tr_end = int(len(yh_raw) * 0.70)
        va_end = int(len(yh_raw) * 0.85)
        # Threshold from the training period only; using the whole series would leak.
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
        # Pick the F1-optimal probability threshold on VAL, not test.
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
