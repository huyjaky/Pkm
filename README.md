# Hoenn Link

Trang web để chơi **pokeemerald-expansion** cùng bạn bè, hoàn toàn trên trình duyệt:

- Mỗi người chơi bản game của riêng mình (mGBA chạy bằng WebAssembly), tự do theo cốt truyện hoặc đi đâu tuỳ thích. Không có ràng buộc nào giữa các người chơi.
- **Minimap**: thấy vị trí của nhau trên bản đồ vùng Hoenn, kèm radar những người đang ở cùng bản đồ.
- **PVP**: thách đấu 1v1 (đấu đơn / đấu đôi) và phòng **đấu đội 2v2**, dùng chính đội hình đang có trong game. Có bảng xếp hạng thắng/thua.
- Chat chung, save **tự động đồng bộ** lên máy chủ, điều khiển cảm ứng trên điện thoại.

## Cách hoạt động

```
Trình duyệt (mỗi người)                         Máy chủ (Docker)
┌───────────────────────────────┐   WebSocket   ┌──────────────────────────────────┐
│ mGBA wasm ── chạy ROM          │──────────────▶│ FastAPI (Python, conda env)       │
│   │ đọc RAM: vị trí, đội hình  │  vị trí, đội  │  ├ tài khoản, save (SQLite)       │
│   ▼                            │  hình, chat   │  ├ hub: minimap, chat, thách đấu  │
│ React UI: minimap, chat, PVP   │◀──────────────│  └ battle engine (Node + Pokémon  │
└───────────────────────────────┘   trận đấu    │     Showdown simulator)           │
                                                └──────────────────────────────────┘
```

- **ROM** được build từ source ngay trong Docker (`make`), sau đó `tools/extract_assets.py` lấy ra: địa chỉ RAM (`gSaveBlock1Ptr`, `gParties`, `gMapHeader`…), bảng species/move/item, sprite, và ảnh bản đồ vùng cho minimap.
- **Đọc RAM**: mgba-wasm không có API đọc bộ nhớ, nên web tạm dừng game, chụp một save state, rồi tìm đúng vùng IWRAM/EWRAM đó trong heap WebAssembly. Sau lần dò này, việc đọc vị trí và đội hình (4 lần/giây) gần như không tốn gì.
- **PVP** dùng simulator của Pokémon Showdown (cơ chế Gen 9, hỗ trợ Mega/Tera như bản expansion). Đội hình được giải mã từ RAM, hồi đầy máu, và có thể quy về Lv 50 / Lv 100 hoặc giữ nguyên cấp. Khi vào trận PVP, game của bạn tự tạm dừng và chạy tiếp sau trận.

## Triển khai (Docker + tên miền)

Yêu cầu: máy chủ Linux có Docker, một tên miền trỏ về IP máy chủ, mở cổng 80 và 443.

> HTTPS là bắt buộc: emulator dùng đa luồng (SharedArrayBuffer), trình duyệt chỉ cho phép trên trang HTTPS (hoặc localhost). Caddy trong `docker-compose.yml` tự xin chứng chỉ Let's Encrypt.

```bash
cp .env.example .env
```

Sửa `.env`: đặt `DOMAIN` (ví dụ `pkm.tenmien.com`) và nên đặt `INVITE_CODE` để chỉ bạn bè có mã mới tạo được tài khoản.

```bash
docker compose up -d --build
```

Lần build đầu mất khoảng 10–20 phút vì phải biên dịch ROM. Sau đó mở `https://<DOMAIN>`, tạo tài khoản và gửi link cho bạn bè.

Cập nhật lên bản expansion mới hơn hoặc build một nhánh/fork khác: đổi `ROM_REF` / `ROM_REPO` trong `.env`, rồi:

```bash
docker compose build --no-cache app && docker compose up -d
```

Save của người chơi nằm trong volume `hoenn-data` (file `/data/hoenn-link.db`), không mất khi build lại.

### Chạy thử trên máy mình (không cần tên miền)

```bash
docker compose -f docker-compose.local.yml up --build
```

Mở `http://localhost:8000`. Chỉ chính máy đó chơi được (trình duyệt chỉ coi localhost là an toàn khi không có HTTPS).

## Phát triển (Miniconda)

```bash
conda env create -f environment.yml
```

```bash
conda activate pkm-online
```

Cài thư viện Node cho battle engine và web:

```bash
cd battle-engine && npm install && cd ../web && npm install && cd ..
```

Trích xuất asset từ một thư mục pokeemerald-expansion **đã build** (có `pokeemerald.gba` và `pokeemerald.elf`):

```bash
python tools/extract_assets.py --repo path/to/pokeemerald-expansion --out .dev-assets
```

Chạy backend (port 8000) và web dev server (port 5173, proxy sang backend):

```bash
python -m uvicorn app.main:app --app-dir server --reload --port 8000
```

```bash
cd web && npm run dev
```

Test:

```bash
python -m pytest server/tests
```

```bash
cd battle-engine && ASSETS_DIR=../.dev-assets npm test
```

```bash
cd web && npm test
```

## Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DOMAIN` | — | Tên miền cho Caddy (bắt buộc với `docker-compose.yml`) |
| `INVITE_CODE` | trống | Mã mời khi đăng ký; trống = đăng ký tự do |
| `ROM_REPO`, `ROM_REF` | rh-hideout / `master` | Source ROM để build |
| `SESSION_DAYS` | 30 | Thời gian giữ đăng nhập |
| `DATA_DIR` | `/data` | Nơi lưu SQLite (tài khoản, save) |

## Điều khiển

Bàn phím: mũi tên di chuyển, `X` = A, `Z` = B, `A`/`S` = L/R, `Enter` = Start, `Backspace` = Select. Trên điện thoại có D-pad và nút A/B trên màn hình. Khi gõ chat, phím không truyền vào game.

## Giới hạn hiện tại

- PVP chạy trên simulator Showdown chứ không phải trận link trong ROM, nên một số chiêu/đặc tính tự chế riêng của bản hack (nếu có) sẽ không có trong PVP.
- Vị trí hiển thị theo khu vực (thành phố/route) trên bản đồ vùng và theo toạ độ ô khi ở cùng bản đồ; người chơi không thấy sprite của nhau bên trong game.
- Mỗi tài khoản chỉ mở được một tab cùng lúc (tab mới sẽ ngắt tab cũ).
