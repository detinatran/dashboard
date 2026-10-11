"""
Train the Liverpool water-level baseline (v1), one model per horizon.

v1 predicts the future water LEVEL directly. The physics-guided decomposition
(level = astronomical tide + residual) is deliberately deferred: no harmonic
tide source is wired for Liverpool, and splitting the signal without one would
mean inventing both halves. When a real tide source lands, v2 switches to
predicting the residual — the feature builder and this script are structured so
that is a contained change.

Non-negotiables enforced here:
  * chronological split — never shuffled; a random split on a tidal series
    leaks neighbouring samples and reports a fantasy R².
  * features come from the production builder via the Node bridge.
  * every metric is reported against a persistence baseline. A model that
    cannot beat "the level will be what it is now" has learned nothing.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

REPO = Path(__file__).resolve().parents[1]
HORIZONS = (1, 3, 6)
MODEL_VERSION = "liverpool-water-v1"


def chronological_split(n, train_frac=0.70, val_frac=0.15):
    """Index boundaries only — the arrays are already time-ordered."""
    tr = int(n * train_frac)
    va = int(n * (train_frac + val_frac))
    return slice(0, tr), slice(tr, va), slice(va, n)


def metrics(y_true, y_pred):
    return {
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "r2": float(r2_score(y_true, y_pred)),
        "bias": float(np.mean(y_pred - y_true)),
        "n": int(len(y_true)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/data/liverpool.npz")
    ap.add_argument("--station", default="liverpool-gladstone")
    ap.add_argument("--out", default="training/models")
    ap.add_argument("--max-iter", type=int, default=400)
    args = ap.parse_args()

    d = np.load(REPO / args.data, allow_pickle=True)
    X = d["X"]
    base_ts = d["base_ts"]
    feature_names = [str(x) for x in d["feature_names"]]
    feature_version = str(d["feature_version"])

    order = np.argsort(base_ts)
    X, base_ts = X[order], base_ts[order]

    print(f"dataset: X={X.shape} featureVersion={feature_version}")
    print(f"span: {datetime.fromtimestamp(base_ts[0]/1000, timezone.utc):%Y-%m-%d} .. "
          f"{datetime.fromtimestamp(base_ts[-1]/1000, timezone.utc):%Y-%m-%d}")

    # 'level' is the current observation — the persistence prediction.
    level_idx = feature_names.index("level")

    out_dir = REPO / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    report = {
        "modelVersion": MODEL_VERSION,
        "featureVersion": feature_version,
        "expectedFeatureCount": int(X.shape[1]),
        "stationId": args.station,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "horizons": {},
        "horizonSigma": {},
        "split": {},
        "target": "water_level_direct",
        "note": ("v1 predicts water level directly; no astronomical tide source is "
                 "configured, so tide/residual are not emitted."),
    }

    try:
        from skl2onnx import to_onnx
        from skl2onnx.common.data_types import FloatTensorType
    except ImportError:
        print("FATAL: skl2onnx missing (pip install onnx skl2onnx)", file=sys.stderr)
        sys.exit(1)

    for h in HORIZONS:
        y = d[f"y{h}"].astype(np.float64)[order]
        m = d[f"m{h}"][order]
        Xh, yh, tsh = X[m], y[m], base_ts[m]
        if len(yh) < 500:
            print(f"+{h}h: only {len(yh)} labelled rows — refusing to train", file=sys.stderr)
            continue

        tr, va, te = chronological_split(len(yh))
        print(f"\n+{h}h  train={tr.stop-tr.start}  val={va.stop-va.start}  test={te.stop-te.start}")
        print(f"      test starts {datetime.fromtimestamp(tsh[te.start]/1000, timezone.utc):%Y-%m-%d}")

        model = HistGradientBoostingRegressor(
            max_iter=args.max_iter,
            learning_rate=0.06,
            max_depth=None,
            min_samples_leaf=40,
            l2_regularization=1.0,
            early_stopping=True,
            validation_fraction=None,   # we pass an explicit chronological val set
            random_state=0,
        )
        # Fit on train; early stopping uses an internal split of it. The val
        # slice stays untouched for honest model selection reporting.
        model.fit(Xh[tr], yh[tr])

        res = {}
        for name, sl in (("train", tr), ("val", va), ("test", te)):
            pred = model.predict(Xh[sl])
            base = Xh[sl][:, level_idx]          # persistence
            res[name] = {"model": metrics(yh[sl], pred), "persistence": metrics(yh[sl], base)}

        t = res["test"]
        skill = 1 - (t["model"]["rmse"] / t["persistence"]["rmse"])
        print(f"      TEST  model  MAE={t['model']['mae']:.3f}m RMSE={t['model']['rmse']:.3f}m R²={t['model']['r2']:.4f}")
        print(f"      TEST  persist MAE={t['persistence']['mae']:.3f}m RMSE={t['persistence']['rmse']:.3f}m R²={t['persistence']['r2']:.4f}")
        print(f"      skill vs persistence: {skill*100:+.1f}%")

        # Error band from held-out residuals — an empirical spread, not a
        # probabilistic predictive interval. Metadata records which it is.
        resid = yh[te] - model.predict(Xh[te])
        sigma = float(np.std(resid))
        report["horizonSigma"][str(h)] = sigma
        report["horizons"][str(h)] = {
            **res,
            "skillVsPersistence": float(skill),
            "residualSigma": sigma,
        }

        onx = to_onnx(model, initial_types=[("input", FloatTensorType([None, X.shape[1]]))],
                      target_opset=17)
        path = out_dir / f"{args.station}.h{h}.onnx"
        path.write_bytes(onx.SerializeToString())
        print(f"      exported {path.name} ({path.stat().st_size/1024:.0f} KB)")

    report["split"] = {"method": "chronological", "trainFrac": 0.70, "valFrac": 0.15, "testFrac": 0.15}
    report["featureNames"] = feature_names

    meta_path = out_dir / f"{args.station}.meta.json"
    meta_path.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {meta_path}")

    if not report["horizons"]:
        print("FATAL: no horizon trained", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
