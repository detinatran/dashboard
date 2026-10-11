/**
 * Triều thiên văn — nội suy từ chuỗi tính sẵn.
 *
 * KHÔNG tự tái tạo từ hệ số điều hoà. Tôi đã thử và sai tới 6 m (gần như ngược
 * pha): quy ước pha của utide là pha Greenwich theo thời gian thiên văn kèm
 * hiệu chỉnh nút mặt trăng thay đổi theo thời điểm, không phải
 * `A·cos(2πft − g)` tính từ một epoch tự chọn. Thay vì đoán tiếp quy ước của
 * một thư viện hải dương học, `training/export_tide_series.py` để utide tính
 * sẵn chuỗi 15 phút và module này chỉ nội suy tuyến tính.
 *
 * Sai số nội suy: trên chuỗi 15 phút của dao động 12.4h, sai số tuyến tính
 * dưới 1 cm — nhỏ hơn hai bậc so với residual stdev 0.19 m.
 *
 * GIỚI HẠN: triều suy ra từ quan trắc tại trạm, KHÔNG phải số liệu chính thức
 * UKHO/Admiralty; không dùng cho hàng hải. Chuỗi có hạn dùng (coverageTo) —
 * hết hạn thì trả `tide_series_expired` chứ không ngoại suy bừa.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadTideModel(dir, stationId) {
  const path = join(dir, `${stationId}.tide.json`);
  if (!existsSync(path)) return { status: 'tide_model_not_configured' };
  let m;
  try {
    m = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { status: 'tide_model_incompatible', reason: String(err?.message || err) };
  }
  if (!Array.isArray(m.values) || m.values.length < 2) {
    return { status: 'tide_model_incompatible', reason: 'chuỗi triều rỗng' };
  }
  if (!(Number(m.varianceExplained) > 0.9)) {
    return {
      status: 'tide_model_incompatible',
      reason: `khớp điều hoà chỉ giải thích ${(Number(m.varianceExplained) * 100).toFixed(2)}% phương sai`,
    };
  }
  if (!Number.isFinite(m.startMs) || !Number.isFinite(m.stepMs) || m.stepMs <= 0) {
    return { status: 'tide_model_incompatible', reason: 'thiếu startMs/stepMs' };
  }
  return { status: 'ready', model: m };
}

/**
 * Triều tại tMs, nội suy tuyến tính. Ngoài phạm vi chuỗi -> null (KHÔNG ngoại
 * suy: ngoài vùng phủ, một phép ngoại suy tuyến tính trên sóng hình sin sai
 * rất nhanh và sẽ được hiển thị như số thật).
 */
export function predictTideAt(loaded, tMs) {
  if (loaded?.status !== 'ready') return null;
  const { startMs, stepMs, values } = loaded.model;
  const pos = (tMs - startMs) / stepMs;
  if (!Number.isFinite(pos) || pos < 0 || pos > values.length - 1) return null;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = values[i];
  const b = values[Math.min(i + 1, values.length - 1)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * frac;
}

/** Triều cho nhiều mốc; phần tử nào ngoài phạm vi thì tide = null. */
export function predictTideSeries(loaded, timestamps) {
  if (loaded?.status !== 'ready') return null;
  return timestamps.map((ts) => ({ ts, tide: predictTideAt(loaded, ts) }));
}

/** Chuỗi còn hiệu lực tại thời điểm này không? */
export function isTideSeriesValidAt(loaded, tMs) {
  if (loaded?.status !== 'ready') return false;
  const { startMs, stepMs, values } = loaded.model;
  const endMs = startMs + (values.length - 1) * stepMs;
  return tMs >= startMs && tMs <= endMs;
}

export function tideModelMeta(loaded) {
  if (loaded?.status !== 'ready') return { status: loaded?.status ?? 'unknown', reason: loaded?.reason };
  const m = loaded.model;
  return {
    status: 'ready',
    method: m.method,
    varianceExplained: m.varianceExplained,
    residualStd: m.residualStd,
    coverageFrom: m.coverageFrom,
    coverageTo: m.coverageTo,
    caveats: m.caveats ?? [],
  };
}
