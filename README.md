# Hoenn Link

Trang web để chơi **pokeemerald-expansion** cùng bạn bè, hoàn toàn trên trình duyệt:

- Mỗi người chơi bản game của riêng mình (mGBA chạy bằng WebAssembly), tự do theo cốt truyện hoặc đi đâu tuỳ thích. Không có ràng buộc nào giữa các người chơi.
- **Thấy nhau ngay trong game**: khi đứng cùng bản đồ, nhân vật của bạn bè xuất hiện và đi lại trong thế giới game (đi bộ, đạp xe, lướt sóng đúng sprite), không chắn đường ai.
- **Minimap**: thấy vị trí của nhau trên bản đồ vùng Hoenn, kèm radar những người đang ở cùng bản đồ.
- **PVP**: thách đấu 1v1 (đấu đơn / đấu đôi) và phòng **đấu đội 2v2**, dùng chính đội hình đang có trong game. Có bảng xếp hạng thắng/thua.
- **Không mất tiến trình**: cứ 5 giây trang tự tạo một điểm khôi phục (save state) và đồng bộ save trong game lên máy chủ. Bấm F5 hay quay lại sau, game tự mở và tiếp tục đúng chỗ cũ.
- **Chống AFK trong PVP**: mỗi lượt có đồng hồ đếm ngược (mặc định 60 giây); ai không chọn kịp sẽ bị xử thua (đấu đội thì cả đội thua).
- Chat chung, chỉnh tốc độ game (1x–4x) trong Cài đặt, điều khiển cảm ứng trên điện thoại.

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
- **Patch ROM** (`rom-patch/`): thêm `src/online_players.c` vào source trước khi build. Mỗi khung hình, ROM ghi trạng thái của chính người chơi vào `gOnlineSelf` và vẽ bạn bè từ bộ đệm `gOnlinePlayers` (tối đa 8 người cùng bản đồ) thành các nhân vật đi lại. Web ghi vị trí bạn bè vào bộ đệm đó qua bộ nhớ emulator; ROM không tự kết nối mạng.
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

Trên Windows: cài [Docker Desktop](https://www.docker.com/products/docker-desktop/) (bật WSL2 khi được hỏi), mở Docker Desktop cho đến khi nó báo đang chạy, rồi trong thư mục dự án:

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
| `BATTLE_TURN_SECONDS` | 60 | Thời gian tối đa cho mỗi lượt PVP trước khi bị xử thua vì AFK |
| `DATA_DIR` | `/data` | Nơi lưu SQLite (tài khoản, save) |

## Điều khiển

Nút ☰ ở góc trên trái mở menu (bản đồ, người chơi, đấu, chat, cài đặt); minimap ở góc trên phải kéo góc để phóng to. Bàn phím: mũi tên di chuyển, `X` = A, `Z` = B, `A`/`S` = L/R, `Enter` = Start, `Backspace` = Select. Trên điện thoại có D-pad và nút A/B trên màn hình. Khi gõ chat, phím không truyền vào game.

## Giới hạn hiện tại

- PVP chạy trên simulator Showdown chứ không phải trận link trong ROM, nên một số chiêu/đặc tính tự chế riêng của bản hack (nếu có) sẽ không có trong PVP.
- Nhân vật bạn bè trong game là "bóng": không nói chuyện, đổi đồ hay đấu trực tiếp trong game được; PVP đi qua sảnh Đấu của trang web. Khi bạn bè lướt sóng, chỉ thấy tư thế lướt, không có thú cưỡi bên dưới.
- Patch ROM được áp vào source upstream bằng các điểm neo cố định. Nếu bản expansion mới đổi các đoạn đó, bước build Docker sẽ dừng với thông báo rõ ràng thay vì âm thầm bỏ tính năng.
- Mỗi tài khoản chỉ mở được một tab cùng lúc (tab mới sẽ ngắt tab cũ).
