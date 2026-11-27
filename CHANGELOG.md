# Changelog

รูปแบบตาม [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) และใช้ [Semantic Versioning](https://semver.org/)

## [1.0.0] - 2026-11-27

### เพิ่ม

- Thai DRG 6.3.4 grouper เขียนด้วย JavaScript
  - ตรรกะจากหนังสือ Thai DRG Version 6.3.3 ของ สรท.
  - ใช้ตาราง dbf รุ่น 6.3.4
- REST API:
  - `POST /api/v1/group`
  - `POST /api/v1/group/batch`
  - `GET /api/v1/drg/{code}`
  - `GET /api/v1/versions`
  - `GET /api/v1/codes`
  - `GET /health`
  - Swagger UI ที่ `/docs`
- `npm run setup`: ดาวน์โหลดไฟล์จาก สรท. ตรวจ SHA-256 และสร้าง `rules.json`
- `npm run compare`: เทียบผลกับ `TGrp6305.exe` แบบกล่องดำ
  - ตรงกัน 99.97% จาก 38,000 ราย
- Docker image ที่ `ghcr.io/somprasongd/thai-drg-grouper` (linux/amd64, linux/arm64)
  - image มีแต่โค้ด ไม่มีไฟล์ของ สรท.
  - เริ่มครั้งแรกจะดาวน์โหลดไฟล์และสร้างกฎลง volume `/data`
- compose.yaml
- CI และงาน Release บน GitHub Actions

[1.0.0]: https://github.com/somprasongd/thai-drg-grouper/releases/tag/v1.0.0
