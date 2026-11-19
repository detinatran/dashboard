# CrisisTwin UK — Kế hoạch & tiến độ

Dashboard bản sao số (digital twin) tích hợp AI để giám sát, dự báo và mô phỏng tác động dây chuyền của khủng hoảng tại Vương quốc Anh. CrisisTwin được xây thành variant `uk` bên trong World Monitor (repo này, fork `detinatran/dashboard`).

Cập nhật: 13/10/2026

---

## 1. Ý tưởng cốt lõi

Hệ thống trả lời 4 câu hỏi:

| Câu hỏi | Module | Trạng thái |
|---|---|---|
| **Điều gì đang xảy ra?** | Live Crisis Monitor, Digital Twin Map | ✅ Xong |
| **Điều gì sẽ xảy ra?** | AI Risk Prediction (Risk Outlook) | ✅ Xong |
| **Cái gì sẽ bị ảnh hưởng?** | Knowledge Graph, Cascading Impact Simulator, Resilience Index | ✅ Xong |
| **Nếu ta làm…?** | What-if Scenario Lab | ✅ Xong |
| *Giải thích và gợi ý* | AI Decision Copilot | ⏳ Chưa làm, cần key LLM |

---

## 2. Các quyết định đã chốt

- **Hình thức:** variant `uk` trong worldmonitor, có thương hiệu CrisisTwin riêng. Không viết app mới.
- **Dữ liệu tổ chức:** hạ tầng công khai thật của UK, cộng một công ty mẫu giả lập là **Albion Provisions Ltd** (thực phẩm và đồ gia dụng).
- **Kịch bản demo:** phát lại bão thật kết hợp bão giả lập. Hiện mới có kịch bản giả lập; phần phát lại bão thật chưa làm.
- **Deploy:** trước mắt chạy local để demo và quay video. Vercel Hobby không deploy được bản đầy đủ (giới hạn 12 function, app có khoảng 208).
- **Nguyên tắc kỹ thuật:** mọi module UK chạy trên trình duyệt, gọi thẳng các API công khai, không cần key và cho phép CORS. Không phụ thuộc Redis hay Railway.

---

## 3. Các giai đoạn

### Giai đoạn 1 — Nền tảng + Live Monitor ✅
Commit `ab832b8a4`, sửa theo review ở `4f6b20c2e`

- Variant `uk` gồm: tên CrisisTwin, favicon và OG image riêng, bản đồ mở sẵn ở UK, nút 🇬🇧 trên header, định tuyến subdomain `uk.*`.
- **Panel Live Crisis Monitor:**
  - Nguồn cảnh báo: lũ (Environment Agency), thời tiết (Met Office, qua rss-proxy), lưới điện (NESO, Elexon SYSWARN), TfL, động đất (BGS).
  - Kèm cường độ carbon, tỷ lệ năng lượng tái tạo và nhu cầu điện.
  - Làm mới 5 phút một lần.
- **Layer bản đồ:**
  - `ukAlerts`: cảnh báo có toạ độ, tô màu theo mức độ.
  - `ukTwin`: 112 node và 178 cạnh phụ thuộc.
- **Tin tức:** panel tin UK, panel tin khủng hoảng/chống chịu, live TV (BBC News, Sky News, GB News).
- **Dữ liệu twin** (`shared/uk-twin-data.ts`):
  - 93 tài sản công khai: cảng, nhà máy điện, interconnector, khí và LNG, sân bay, đường sắt, bệnh viện, nhà máy nước, data centre.
  - 19 node của công ty mẫu.
- **Sửa theo review UX:**
  - Cảnh báo được đặt lên đầu.
  - Tab Alerts trên mobile hoạt động đúng.
  - Nút ◎ không còn bị tay nắm resize che.
  - Bỏ popup Mission và Discord.
  - Tăng cỡ chữ, ẩn badge CRED/UNREVIEWED.
  - Bản đồ chỉ bật các layer thiết yếu.

### Giai đoạn 2 — Knowledge Graph + Cascade ✅
Commit `b393cef76`

- **Engine lan truyền** (`src/services/uk/cascade.ts`):
  - Mất công suất lan theo cạnh phụ thuộc, có trọng số.
  - Nguồn thay thế còn khỏe hấp thụ 65% thiệt hại.
  - Có chặn vòng lặp.
- **Panel Digital Twin & Cascade:**
  - Đồ thị tri thức d3-force; bấm node để cho hỏng hoặc khôi phục.
  - Danh sách thiệt hại kèm thanh %.
  - Chỉ số gián đoạn dịch vụ cửa hàng.
- **4 kịch bản:** bão dâng Humber, triều cường Thames, đóng cảng Felixstowe, mất toàn bộ interconnector.
- Bản đồ đổi màu node và cạnh theo mức thiệt hại.

### Giai đoạn 3a — Risk Outlook + Resilience Index ✅
Commit `6a5eeca8c`

- **Dự báo 72 giờ cho từng tài sản:**
  - Đặc trưng đầu vào: mưa và gió giật (Open-Meteo), lưu lượng sông so với phân vị 95 của 365 ngày (GloFAS), cảnh báo EA trong bán kính 12 km.
  - Mô hình minh bạch: mỗi điểm số liệt kê các yếu tố góp phần.
- **"Simulate predicted impact":** đưa xác suất rủi ro vào engine lan truyền.
- **Resilience Index cho 12 vùng ITL1** (thang 0–100), tính từ:
  - mức dự phòng (35%),
  - mức phơi nhiễm lũ của tài sản trọng yếu (25%),
  - mức phụ thuộc điểm đơn (20%),
  - nguy cơ theo dự báo (20%).
- **Tiết kiệm hạn mức Open-Meteo:**
  - Khí hậu học sông cache 7 ngày trong localStorage.
  - Các node trùng ô lưới được gộp (112 node → 108 điểm).

### Giai đoạn 3b — What-if Lab ✅
Commit `0926e5454`

- Đây là tab trong panel Digital Twin. Người dùng chọn hiểm hoạ và hai phương án (đóng site, hoặc đổi tuyến sang site cùng loại), rồi so với ngày thường và với không hành động.
- Ba chỉ số: dịch vụ cửa hàng, thời gian giao (của hàng đã giao), chi phí logistics (ngày thường = 100).
- Có khuyến nghị tự động: ưu tiên dịch vụ cao nhất; nếu chênh nhau dưới 2 điểm thì chọn phương án rẻ hơn.

Ví dụ với bão dâng Humber:

| | Không làm gì | Đóng nhà máy Hull | Đổi sản xuất sang Burton |
|---|---|---|---|
| Dịch vụ cửa hàng | 85,5% | 88,7% | **97,9%** ✓ |
| Thời gian giao | 3,8 h | 4,3 h | 5,4 h |
| Chi phí | 243 | 208 | 253 |

### Giai đoạn 3c — Ontology sự cố + tập trung England ✅

- **Ontology 10 loại sự cố** (`src/services/uk/ontology.ts`): flood, severe weather, accident, public disorder, strike, infrastructure failure, grid, transport, cyber, seismic.
  - Nguồn có cấu trúc map thẳng vào ontology: EA (flood), Met Office (weather), NESO (grid), TfL (transport), BGS (seismic), **NCSC** (cyber — nguồn mới, RSS qua rss-proxy).
  - Các loại không có API công khai không-key (accident, disorder, strike, infrastructure, cyber trực tiếp) lấy từ **tín hiệu tin en-GB** (3 query Google News RSS qua rss-proxy), phân loại theo từ khóa từng tiêu đề.
  - Chống nhiễu: tiêu đề phải có địa danh/thực thể UK; loại tin nhắc địa danh nước ngoài (Paris, Taiwan…); loại "collapse"/"crash" nghĩa bóng (chứng khoán, cricket) trừ khi có sự cố vật lý; "strike" quân sự không tính là đình công; khử trùng lặp theo tiêu đề chuẩn hóa; tối đa 6 tin/loại.
  - National Highways RSS (UnplannedEvents) đã chết — sự cố đường bộ hiện dựa vào tín hiệu tin.
- **Panel Live Crisis Monitor**: 10 chip KPI theo ontology, lọc theo loại, nguồn mới hiện nhãn NCSC / UK news signal.
- **Tập trung England**: bỏ 4 layer toàn cầu khỏi menu bản đồ uk (NWS/ECCC weather, natural events, internet disruptions, webcams); ẩn region selector (desktop + mobile menu) — bản đồ ghim UK; siết query "UK Transport Disruption" (bỏ "flights cancelled" chung chung, thay bằng sân bay UK) để hết lọt tin nước ngoài.
- Test: `tests/uk-crisis-sources.test.mts` thêm 4 cụm test ontology (phân loại, lọc quân sự, lọc nhiễu, parse news/NCSC).

### Giai đoạn 3d — Dọn giao diện + Guide tour ✅

- **Dọn chrome cho variant uk:** ẩn Mission preset, Export, Intelligence badge, Historical playback, nút Link/Embed, AOI, CCTV (giữ CRDT), footer chỉ còn GitHub; bỏ panel My Monitors khỏi preset.
- **Thoáng hơn:** gutter lưới panel 4px → 14px, panel bo góc 12px, header/content panel rộng rãi hơn (override theo `[data-variant="uk"]`).
- **Icon tự sinh:** 10 icon loại sự cố là PNG trong suốt duotone tại `public/uk-icons/` (không dùng emoji). Codex CLI không có trên máy nên bộ icon được vẽ SVG rồi render PNG bằng headless Edge (script tái tạo được).
- **Guide tour** (`src/components/UkGuideTour.ts`): spotlight 6 bước theo 4 câu hỏi của sản phẩm (Monitor → Map → Risk Outlook → Twin & Cascade → What-if → kết). Tự chạy một lần mỗi trình duyệt (localStorage `wm-uk-tour-v1`, chỉ desktop), mở lại bằng nút ✦ Tour trên header; điều khiển bằng chuột hoặc phím (←/→/Enter/Esc).
- **Một quốc gia duy nhất:** ở bản uk, bấm (hoặc chuột phải) nước khác trên bản đồ không mở country brief toàn cầu nữa — chỉ GB được phép; ⌘K cũng không còn lệnh brief/map của nước khác lẫn lệnh nhảy vùng (`nav:*`).
- **Clip hạ tầng về UK** (`src/config/uk-bounds.ts`): 4 layer cables/pipelines/nuclear/datacenters chỉ còn vẽ và index các asset chạm khung UK (vĩ 49.5–61.2, kinh −8.8–2.2); ⌘K bỏ luôn nguồn hotspot/conflict/irradiator toàn cầu ở bản uk. Dataset gốc giữ nguyên cho các variant khác.

### Giai đoạn 3e — Cascade theo giờ + Critical nodes + cột 3D ✅

- **`simulateCascadeTimeline()`** (`src/services/uk/timeline.ts`): cascade lan 1 cạnh/giờ; mỗi tài sản có **giờ tự chủ** theo loại (bệnh viện 48h máy phát, data centre 24h, kho phân phối 36h tồn kho, cửa hàng 24h…), hết buffer thì ramp 3h lên mức loss truyền tới. Frame cuối hội tụ về engine tĩnh (có test đối chiếu). Trả về chuỗi frame theo giờ + giờ peak của gián đoạn cửa hàng.
- **Thanh thời gian trong panel Twin**: nút ▶/⏸ + slider 0–72h; tua giờ nào thì đồ thị, danh sách thiệt hại, chỉ số dịch vụ và **bản đồ** đổi theo giờ đó (ví dụ Humber: T+2h dịch vụ 100% nhờ buffer, T+67h peak, T+72h còn 47%).
- **Cột 3D trên bản đồ**: ColumnLayer tại node đang mất công suất — cao và đỏ dần theo loss, đổi theo giờ khi tua (nghiêng bản đồ bằng chuột phải để thấy chiều cao). Toggle 2D/3D (globe toàn cầu, không hỗ trợ twin) bị ẩn ở variant uk.
- **`rankCriticalNodes()` / `rankCriticalPairs()`** (`src/services/uk/critical.ts`): N-1 toàn bộ 112 node (điểm = tổng loss có trọng số criticality), N-2 trên các cặp ứng viên top, kèm **synergy** (thiệt hại vượt mức đơn lẻ tệ nhất). Tab mới **Critical nodes** trong panel Twin; bấm hàng nào là mô phỏng ngay hỏng hóc đó. Top hiện tại: St Fergus Gas Terminal, Felixstowe, các nút cao tốc Almondsbury/Catthorpe.
- Test mới: `tests/uk-timeline.test.mts`, `tests/uk-critical.test.mts` (73 test uk-* đều xanh).
- Đề xuất còn lại chưa làm: Monte Carlo outlook, ngập 3D theo địa hình, allocateProtection, replay Storm Babet.

### Giai đoạn 4 — AI Decision Copilot ⏳
- Chat giải thích cảnh báo, kết quả cascade và What-if, gợi ý phương án ứng phó.
- Ngữ cảnh gửi cho mô hình: tình hình hiện tại, top rủi ro, kết quả mô phỏng.
- **Cần quyết định:** nhà cung cấp LLM (Groq, OpenRouter, Anthropic…) và key.
- Có thể tái dùng `ChatAnalystPanel` và `server/_shared/llm.ts` sẵn có.

### Việc tồn đọng
- [ ] Phát lại bão thật (ví dụ Storm Babet 10/2023) từ dữ liệu lưu trữ của EA.
- [ ] Hiển thị Resilience Index trên bản đồ (hiện chỉ có trong panel).
- [ ] Chạy `ANTHROPIC_API_KEY=… node scripts/translate-locales.mjs` để dịch lại theo chuẩn repo và hết lỗi test `app-locale-freshness`.
- [ ] Phần Coastal/CRDT đang dở: thiếu mô tả OpenAPI, cache tier, phủ MCP, watch-path của `seed-coastal`.
- [ ] Deploy: nâng Vercel Pro hoặc tự host bằng Docker.

---

## 4. Giả định của mô hình

Tất cả là hằng số có tên trong code, có thể thay bằng số liệu thực tế.

**Lan truyền** (`cascade.ts`)
- Nguồn thay thế khỏe giữ lại 65% luồng (`substitutionFactor` 0,35).
- Thiệt hại dưới 5% bị coi là nhiễu và bỏ qua.

**Rủi ro** (`risk.ts`)
- Tài sản ven sông: so với lưu lượng ở phân vị 95 của năm.
- Tài sản ven biển: proxy nước dâng là gió giật, điểm giữa 100 km/h.
- Tài sản nhạy gió (cảng, sân bay, điện, LNG): điểm giữa 95 km/h.
- Cảnh báo EA trong bán kính 12 km đặt mức sàn xác suất: 90% (nghiêm trọng), 60% (warning), 30% (alert).

**What-if** (`whatif.ts`)
- Sự kiện kéo dài 3 ngày.
- Site của công ty bị ngập cần thêm 10 ngày sửa chữa; hạ tầng công cộng khôi phục sau sự kiện.
- Đổi tuyến cộng thêm 1,5 giờ; lộ trình vòng dài hơn 1,5 lần.
- Thiệt hại một site tương đương 6 ngày chi phí; đóng rồi mở lại tương đương 0,5 ngày.
- Doanh số mất được tính gấp 3 lần chi phí logistics.

---

## 5. Chạy thử

```bash

npm run dev:uk          # hoặc bấm 🇬🇧 UK trên header
```

Test của CrisisTwin:

```bash
npx tsx --test tests/uk-*.test.mts
```

Có 5 file test: nguồn dữ liệu, dữ liệu twin, cascade, risk và what-if.

Video demo giai đoạn 1: `crisistwin-uk-phase1.mp4` (trong repo cha `oriris`, không commit vào đây).
