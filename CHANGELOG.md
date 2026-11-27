# Changelog

รูปแบบตาม [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) และใช้ [Semantic Versioning](https://semver.org/)

## [Unreleased]

### เพิ่ม

- หน้าเว็บที่ `/` (ปิดได้ด้วย `WEB_UI=off`)
  - กรอกข้อมูลผู้ป่วยแล้วเห็นผลทันที ข้อความ error และ warning เป็นภาษาไทย
  - อัปโหลดไฟล์ .dbf แล้วได้สรุปผลและไฟล์ผลกลับ
  - รองรับมือถือและโหมดมืด ไม่โหลดอะไรจากภายนอก มี CSP แบบเข้ม
  - ถามคีย์เมื่อตั้ง `API_KEY`
- `POST /api/v1/group/file`: ส่งไฟล์ .dbf แบบที่เคยส่งให้ `TGrp6305.exe` แล้วได้ไฟล์เดิมพร้อมผล
  - ไบต์อื่นไม่เปลี่ยน รวมข้อความภาษาไทย TIS-620 ผลตรงกับไฟล์ที่ exe จัดกลุ่มทุกไบต์
  - เพิ่มคอลัมน์ผลให้เมื่อไฟล์ไม่มี สรุปผลใน header `X-Grouper-Summary`
  - ทำงานในหน่วยความจำ ไม่เขียนดิสก์ ไม่มีข้อมูลผู้ป่วยใน log
  - จำกัดจำนวนรายการด้วย `MAX_FILE_RECORDS` (ค่าเริ่มต้น 100000)
- Dockerfile target `bundled`: image ที่ทำ setup ไว้แล้วตอน build ใช้ใน registry ส่วนตัวของหน่วยงาน
  - `docker build --target bundled --build-context tcmc=./cache .`
  - มีไฟล์ของ สรท. อยู่ข้างใน ห้าม push ขึ้นที่สาธารณะ งาน Release ไม่ build target นี้
  - เริ่มได้ทันที ไม่ต้องมี volume และไม่ต้องออกอินเทอร์เน็ต

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

[Unreleased]: https://github.com/somprasongd/thai-drg-grouper/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/somprasongd/thai-drg-grouper/releases/tag/v1.0.0
