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
