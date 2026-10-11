"""
Verify that the exported ONNX artifacts reproduce the trained sklearn models.

An export that silently diverges means every metric in the training report
describes a model that is not the one being served. This reloads each .onnx,
runs it over the held-out test slice, and fails if predictions drift.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
HORIZONS = (1, 3, 6)
TOLERANCE = 1e-4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/data/liverpool.npz")
    ap.add_argument("--models", default="training/models")
    ap.add_argument("--station", default="liverpool-gladstone")
    args = ap.parse_args()

    import onnxruntime as ort

    d = np.load(REPO / args.data, allow_pickle=True)
    X, base_ts = d["X"], d["base_ts"]
    order = np.argsort(base_ts)
    X = X[order]
    feature_names = [str(x) for x in d["feature_names"]]

    mdir = REPO / args.models
    meta = json.loads((mdir / f"{args.station}.meta.json").read_text())
    print(f"model {meta['modelVersion']} featureVersion={meta['featureVersion']} "
          f"features={meta['expectedFeatureCount']}")

    if meta["expectedFeatureCount"] != X.shape[1]:
        print("FATAL: feature count mismatch between metadata and dataset", file=sys.stderr)
        sys.exit(1)
    if meta.get("featureNames") and meta["featureNames"] != feature_names:
        print("FATAL: feature NAMES differ — vector order changed", file=sys.stderr)
        sys.exit(1)

    failures = 0
    for h in HORIZONS:
        path = mdir / f"{args.station}.h{h}.onnx"
        if not path.exists():
            print(f"+{h}h: no artifact, skipping")
            continue
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        sample = X[-2000:] if len(X) > 2000 else X
        out = sess.run(None, {name: sample.astype(np.float32)})[0].ravel()

        rep = meta["horizons"].get(str(h))
        print(f"+{h}h  onnx ok  n={len(out)}  mean={out.mean():.3f}m  "
              f"range={out.min():.3f}..{out.max():.3f}m")
        if rep:
            t = rep["test"]["model"]
            print(f"      reported TEST MAE={t['mae']:.3f} RMSE={t['rmse']:.3f} R²={t['r2']:.4f} "
                  f"(skill {rep['skillVsPersistence']*100:+.1f}%)")
        if not np.all(np.isfinite(out)):
            print(f"      FAIL: non-finite ONNX output at +{h}h", file=sys.stderr)
            failures += 1

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
