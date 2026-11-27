# thai-drg-grouper

[![CI](https://github.com/somprasongd/thai-drg-grouper/actions/workflows/ci.yml/badge.svg)](https://github.com/somprasongd/thai-drg-grouper/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

โปรแกรมจัดกลุ่มผู้ป่วยใน **Thai DRG 6.3.4** เขียนใหม่ทั้งหมดด้วย JavaScript และให้บริการเป็น REST API (HTTP/JSON)

- ไม่ต้องใช้ Windows
- ไม่ต้องเขียนไฟล์ dbf
- ไม่ต้องรัน `TGrp6305.exe`

| | |
|---|---|
| ตรรกะการจัดกลุ่ม | เขียนจาก **หนังสือ Thai DRG Version 6.3.3** ที่ สรท. (TCMC) เผยแพร่ |
| ตารางรหัสและค่าน้ำหนัก | ใช้ **ตาราง dbf รุ่น 6.3.4** ที่มากับโปรแกรม TGrp6305 ของ สรท. |
| `TGrp6305.exe` | ใช้เพียงเป็นตัวเทียบผล: ส่งข้อมูลเข้าแล้วดูผลที่ออกมา **ไม่ได้ถอดหรือแกะโปรแกรม** และไม่มีอยู่ใน repository นี้ |
| ผลเทียบกับ exe | ตรงกัน **99.97%** จาก 38,000 รายที่สุ่ม (ดู[ผลการทดสอบ](#8-ผลการทดสอบเทียบกับ-tgrp6305exe)) |
| ความเร็ว | 10,000 รายใน 0.35 วินาที เริ่มบริการภายใน 0.5 วินาที ใช้หน่วยความจำราว 180 MB |

> **repository นี้ไม่มีไฟล์ของ สรท. เลย** ทั้งตาราง dbf, หนังสือ PDF และกฎที่สร้างจากหนังสือ
> คำสั่ง `npm run setup` (หรือ `docker compose build`) จะดาวน์โหลดไฟล์จากเว็บไซต์ สรท. แล้วสร้างกฎบนเครื่องของคุณเอง ดู [NOTICE](NOTICE)

---

## สารบัญ

1. [เริ่มใช้งานด้วย Docker](#1-เริ่มใช้งานด้วย-docker)
2. [เริ่มใช้งานด้วย Node.js](#2-เริ่มใช้งานด้วย-nodejs)
3. [npm run setup ทำอะไร](#3-npm-run-setup-ทำอะไร)
4. [การตั้งค่า](#4-การตั้งค่า)
5. [API](#5-api)
6. [รหัส Error และ Warning](#6-รหัส-error-และ-warning)
7. [วิธีสร้างจากหนังสือ Thai DRG 6.3.3](#7-วิธีสร้างจากหนังสือ-thai-drg-633)
8. [ผลการทดสอบเทียบกับ TGrp6305.exe](#8-ผลการทดสอบเทียบกับ-tgrp6305exe)
9. [การทดสอบ](#9-การทดสอบ)
10. [โครงสร้างโฟลเดอร์](#10-โครงสร้างโฟลเดอร์)
11. [ปัญหาที่พบบ่อย](#11-ปัญหาที่พบบ่อย)
12. [เอกสารอ้างอิง](#12-เอกสารอ้างอิง)
13. [สัญญาอนุญาตและข้อควรทราบ](#13-สัญญาอนุญาตและข้อควรทราบ)

---

## 1. เริ่มใช้งานด้วย Docker

ต้องมี Docker Engine 23 ขึ้นไป หรือ Docker Desktop

```sh
git clone https://github.com/somprasongd/thai-drg-grouper.git
cd thai-drg-grouper
cp .env.example .env        # ไม่บังคับ
docker compose up -d --build
```

ขั้นตอน build:

- ดาวน์โหลดไฟล์จาก สรท. 3 ไฟล์ รวมราว 71 MB
- แปลงหนังสือเป็นข้อความด้วย poppler (`pdftotext`)
- สร้างกฎ และตรวจด้วยรายทดสอบ 1 ราย
- image สุดท้ายมีเพียง Node.js, โค้ด, ตาราง dbf 4 ไฟล์ และ `rules.json` (ไม่มี PDF และไม่มี exe)

เมื่อพร้อมแล้ว:

- หน้าเอกสาร (Swagger UI): <http://127.0.0.1:8089/docs>
- ตรวจสถานะ: `curl http://127.0.0.1:8089/health`

คำแนะนำ:

- ถ้าเครื่อง build ออกอินเทอร์เน็ตไม่ได้ ให้วาง `S0021.zip`, `S0062.zip`, `S0063.zip` ไว้ในโฟลเดอร์ `cache/` ก่อน build (ดาวน์โหลดได้จาก[ลิงก์ในหัวข้อ 12](#12-เอกสารอ้างอิง))
- compose เปิดพอร์ตให้เฉพาะเครื่องนี้ (`127.0.0.1`) เป็นค่าเริ่มต้น
  - ถ้าให้เครื่องอื่นเรียกได้ ให้ตั้ง `DRG_BIND=0.0.0.0` และตั้ง `API_KEY` ใน `.env`
- container รันด้วยผู้ใช้ `node` (ไม่ใช่ root), filesystem อ่านอย่างเดียว, ตัด capability ทั้งหมด และจำกัดหน่วยความจำ 512 MB

> **อย่า push image ที่ build แล้วขึ้น registry สาธารณะ** เพราะ image มีตารางและกฎที่มาจากเอกสารของ สรท.
> ใช้ภายในหน่วยงานของคุณเอง หรือขออนุญาต สรท. ก่อน

---

## 2. เริ่มใช้งานด้วย Node.js

| ต้องมี | หมายเหตุ |
|---|---|
| Node.js 20.12 ขึ้นไป | CI ทดสอบกับ 20, 22 และ 24 (พัฒนาบน 26) |
| `pdftotext` | ใช้เฉพาะตอน `npm run setup` เลือกอย่างใดอย่างหนึ่ง: poppler-utils (Linux: `apt install poppler-utils`, macOS: `brew install poppler`) หรือ xpdf (Windows: <https://www.xpdfreader.com/download.html>, หรือ `pacman -S mingw-w64-x86_64-poppler` ใน MSYS2) |

```sh
npm ci
npm run setup      # ดาวน์โหลดไฟล์ สรท. และสร้างกฎ ทำครั้งเดียว
npm start          # http://127.0.0.1:8089/docs
```

ถ้า `pdftotext` ไม่อยู่ใน PATH ให้ระบุตำแหน่งเอง:

```sh
npm run setup -- --pdftotext=/path/to/pdftotext
```

หยุดบริการด้วย Ctrl+C (บริการรับ SIGTERM และปิดตัวอย่างเรียบร้อย)

---

## 3. npm run setup ทำอะไร

`tools/setup.mjs` ทำตามลำดับ:

1. ดาวน์โหลดไฟล์ zip 3 ไฟล์จาก `https://www.tcmc.or.th/_content_images/download/fileupload/` ลง `cache/`
   - ถ้ามีไฟล์อยู่แล้วจะใช้ไฟล์ที่มี
   - ตรวจ SHA-256 ทุกไฟล์ ถ้า สรท. เปลี่ยนไฟล์ setup จะหยุดและแจ้ง

   | ไฟล์ | ขนาด | เนื้อหา | ส่วนที่ใช้ |
   |---|---|---|---|
   | `S0021.zip` | 41.9 MB | โปรแกรม TGrp6305 (Thai DRG 6.3.4) | ตาราง `c63i10.dbf`, `c63proc.dbf`, `c63drg.dbf`, `c63ccex.dbf` เท่านั้น ไม่แตกไฟล์ exe/dll |
   | `S0062.zip` | 8.1 MB | หนังสือ Thai DRG 6.3.3 เล่ม 1 และเล่ม 2 | ทั้งสองเล่ม |
   | `S0063.zip` | 21.5 MB | หนังสือ Thai DRG 6.3.3 ภาคผนวก F | `VSup11`–`VSup44` |

2. คัดลอกตาราง 4 ไฟล์ไปที่ `groupers/6.3.4/` และตรวจ SHA-256
3. แปลง PDF เป็นข้อความด้วย `pdftotext -raw -enc UTF-8` ในโฟลเดอร์ชั่วคราว
4. รัน `tools/build-rules.mjs` เพื่อสร้าง `groupers/6.3.4/native/rules.json` แล้วเทียบ SHA-256 กับรุ่นที่ใช้เทียบกับ exe
   - ถ้าไม่ตรง จะเตือน (ใส่ `--strict` เพื่อให้หยุด; Docker ใช้ `--strict`)
5. จัดกลุ่มรายทดสอบ 1 ราย (ผ่าตัดไส้ติ่ง ต้องได้ DRG 06070, RW 1.2127)

ตัวเลือก:

- `--cache=<folder>`
- `--offline` (ไม่ดาวน์โหลด ใช้เฉพาะไฟล์ใน cache)
- `--pdftotext=<path>`
- `--keep-text` (เก็บข้อความที่แปลงไว้ใน `cache/text/`)
- `--strict`

---

## 4. การตั้งค่า

ทุกค่าไม่บังคับ ตั้งได้ใน `.env` (ดู `.env.example`) หรือเป็นตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `HOST` | `127.0.0.1` (ใน Docker `0.0.0.0`) | ที่อยู่ที่รอรับคำขอ |
| `PORT` | `8089` | พอร์ต |
| `API_KEY` | (ว่าง) | ถ้ากำหนด ทุกคำขอ `/api/*` ต้องมี header `X-API-Key` (`/health` และ `/docs` ไม่ต้อง) |
| `DEFAULT_VERSION` | `6.3.4` | รุ่นที่ใช้เมื่อคำขอไม่ระบุ |
| `GROUPERS_DIR` | `./groupers` | โฟลเดอร์ที่มีโฟลเดอร์ย่อยรุ่นละหนึ่งโฟลเดอร์ |
| `MAX_QUEUE` | `200` | คำขอที่รอพร้อมกันได้สูงสุด เกินนี้ได้ HTTP 503 |
| `MAX_BATCH` | `5000` | จำนวนรายสูงสุดต่อคำขอ batch |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` |
| `DRG_BIND`, `DRG_PORT` | `127.0.0.1`, `8089` | (เฉพาะ compose) ที่อยู่และพอร์ตที่เปิดบนเครื่อง host |

---

## 5. API

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| `POST` | `/api/v1/group` | จัดกลุ่ม 1 ราย |
| `POST` | `/api/v1/group/batch` | จัดกลุ่มหลายราย (ไม่เกิน `MAX_BATCH`) ผลเรียงตามลำดับที่ส่ง |
| `GET` | `/api/v1/drg/{code}` | ข้อมูล DRG: ชื่อ, MDC, RW, RW0d, WtLOS, OT |
| `GET` | `/api/v1/versions` | รุ่นที่ให้บริการ |
| `GET` | `/api/v1/codes` | ความหมายของรหัส error, warning และประเภทการจำหน่าย |
| `GET` | `/health` | สถานะ (ไม่ต้องใช้ API key) |
| `GET` | `/docs` | Swagger UI และ OpenAPI (`/docs/json`) |

ระบุรุ่นด้วย query string เช่น `?version=6.3.4` ส่วน batch ใส่ `version` ใน body ได้ด้วย

### 5.1 จัดกลุ่ม 1 ราย

```sh
curl -s -X POST http://127.0.0.1:8089/api/v1/group \
  -H "Content-Type: application/json" \
  -d '{"ref":"AN-6701234","sex":1,"dob":"1980-05-10","admitDate":"2024-01-10T08:30","dischargeDate":"2024-01-13T10:00","dischargeType":1,"pdx":"K35.8","sdx":["E11.9"],"procedures":["47.09"]}'
```

ผลลัพธ์จริง:

```json
{
  "index": 0, "ref": "AN-6701234", "ok": true,
  "version": "6.3.4", "engine": "native",
  "drg": "06070", "dc": "0607", "pcl": 1, "pdxUsed": "K358",
  "drgName": "Appendectomy wo sig CCC", "mdc": "06",
  "rw": 1.2127, "adjrw": 1.2127, "wtlos": 3.05, "ot": 9,
  "los": 3, "age": 43, "ageDay": 245,
  "errorCode": 0, "error": null,
  "warningCode": 0, "warnings": [],
  "notes": []
}
```

### 5.2 จัดกลุ่มหลายราย

```json
POST /api/v1/group/batch
{
  "version": "6.3.4",
  "cases": [
    { "ref": "AN-1", "sex": 1, "dob": "1980-05-10", "admitDate": "2024-01-10T08:30", "dischargeDate": "2024-01-13T10:00", "dischargeType": 1, "pdx": "K35.8", "procedures": ["47.09"] },
    { "ref": "AN-2", "sex": 2, "dob": "2024-03-01", "admitDate": "2024-03-01T02:00", "dischargeDate": "2024-03-04T10:00", "dischargeType": 1, "admitWeight": 1.9, "pdx": "P07.1", "sdx": ["P22.0"] }
  ]
}
```

```json
{ "version": "6.3.4", "count": 2, "grouped": 2, "rejected": 0, "results": [ { "index": 0, "ref": "AN-1", "drg": "06070" }, { "index": 1, "ref": "AN-2", "drg": "15532" } ] }
```

(ตัดฟิลด์อื่นของแต่ละรายออกเพื่อให้อ่านง่าย)

- รายที่ข้อมูลผิดรูปแบบ (เช่น วันที่อ่านไม่ได้) จะได้ `"ok": false` พร้อม `inputErrors`
- รายอื่นในชุดยังจัดกลุ่มตามปกติ

### 5.3 ข้อมูล DRG

```sh
curl -s http://127.0.0.1:8089/api/v1/drg/06070
```

```json
{ "version": "6.3.4", "drg": "06070", "name": "Appendectomy wo sig CCC", "mdc": "06", "rw": 1.2127, "rw0d": 1.1036, "wtlos": 3.05, "ot": 9 }
```

### 5.4 ข้อมูลขาเข้า (case)

| ฟิลด์ | ชนิด | คำอธิบาย |
|---|---|---|
| `ref` | string | รหัสอ้างอิงของผู้เรียก (เช่น AN) ส่งกลับตามเดิม |
| `sex` | 1/2 | 1 = ชาย, 2 = หญิง (รับ `M`/`F` ด้วย) |
| `dob` | `YYYY-MM-DD` | วันเกิด **ปี ค.ศ.** (ปีเกิน 2400 ถูกปฏิเสธเพราะน่าจะเป็น พ.ศ.) |
| `admitDate` | `YYYY-MM-DDTHH:mm` (หรือ `YYYY-MM-DD` คู่กับ `admitTime`) | วันและเวลารับไว้ **ต้องมีเวลา** ถ้าไม่มีจะได้ WARN 128 และ ERR 9 เหมือน exe |
| `admitTime` | `HH:mm` | เวลารับไว้ ถ้าไม่ได้ใส่ใน `admitDate` |
| `dischargeDate` | เหมือน `admitDate` | วัน (และเวลา) จำหน่าย |
| `dischargeTime` | `HH:mm` | เวลาจำหน่าย |
| `dischargeType` | 1–5, 8, 9 | 1 ทุเลา, 2 ไม่สมัครใจอยู่, 3 หนี, 4 ส่งต่อ, 5 อื่น ๆ, 8/9 เสียชีวิต |
| `admitWeight` | kg | น้ำหนักแรกรับ **จำเป็นเมื่ออายุน้อยกว่า 28 วัน** |
| `age`, `ageDay` | ตัวเลข | อายุ (ปี) และวันนับจากวันเกิดล่าสุด ถ้าไม่ส่งจะคำนวณจาก `dob` |
| `pdx` | string | การวินิจฉัยหลัก ICD-10 (มีจุดได้) |
| `sdx` | array หรือ string คั่นด้วย `,` | การวินิจฉัยรอง ใช้ไม่เกิน 12 รหัส |
| `procedures` | array หรือ string | หัตถการ ICD-9-CM (มีจุดได้ ใส่ extension code ได้ เช่น `01.25+21`) ใช้ไม่เกิน 20 รหัส |
| `leaveDays` | ตัวเลข | วันลากลับบ้าน (หักจาก LOS) ค่าเริ่มต้น 0 |

API ปรับข้อมูลให้ และบอกทุกอย่างที่ปรับใน `notes`:

- ตัดจุดออกจากรหัส
- ตัด ICD-10 ที่ยาวเกิน 6 ตัว และ ICD-9-CM ที่ยาวเกิน 7 ตัว
- ตัดรหัสที่เกินจำนวน

**Extension code (เล่ม 1 บทที่ 4):**

- รูปแบบคือ `รหัส+XY`
  - X = จำนวนตำแหน่ง (site)
  - Y = ครั้งที่ผ่าตัด (setting) ต้องเริ่มที่ 1 และต่อเนื่องกัน มิฉะนั้น extension จะถูกตัดทิ้ง
- ตัวอย่างกับ PDx S02.81:

| procedures | DRG |
|---|---|
| `01.25` | 01010 |
| `01.25+21` (2 ตำแหน่งในครั้งเดียว) | 01129 |
| `01.25+11`, `01.25+12` (2 ครั้ง) | 01129 |
| `01.25+12` อย่างเดียว (ไม่มีครั้งที่ 1) | 01010 |

### 5.5 ผลลัพธ์ (result)

| ฟิลด์ | คำอธิบาย |
|---|---|
| `index`, `ref` | ลำดับในคำขอ และ `ref` ที่ส่งมา |
| `ok` | `false` เมื่อข้อมูลผิดจนจัดกลุ่มไม่ได้ (ดู `inputErrors`) |
| `version`, `engine` | รุ่นที่ใช้ และ engine (`native` เสมอ) |
| `drg`, `drgName`, `mdc` | DRG, ชื่อ DRG, MDC |
| `dc`, `pcl` | Disease Cluster และระดับ PCL ที่ใช้เลือก DRG |
| `pdxUsed` | PDx ที่ใช้จริงหลัง reassign เช่น PDx J18.9 ที่มี SDx S02.81 และผ่าตัดสมอง จะได้ `S0281` |
| `rw`, `adjrw` | Relative Weight และ RW ที่ปรับตามวันนอน (เล่ม 1 ภาคผนวก H) |
| `wtlos`, `ot` | วันนอนเฉลี่ยถ่วงน้ำหนัก และจุดตัดวันนอนนาน |
| `los` | วันนอนที่ใช้คำนวณ |
| `age`, `ageDay` | อายุที่ใช้คำนวณ |
| `errorCode`, `error` | รหัสและข้อความ error (0 / `null` = ไม่มี) |
| `warningCode`, `warnings` | ผลรวม bit ของ warning และรายการแยกทีละข้อ |
| `notes` | สิ่งที่ API ปรับในข้อมูลขาเข้า |
| `inputErrors` | ปัญหาของข้อมูลขาเข้า (เมื่อ `ok: false`) |

### 5.6 รหัสสถานะ HTTP

| สถานะ | เมื่อไร |
|---|---|
| 200 | สำเร็จ ถึง grouper จะให้ error code (เช่น ERR 2) ก็ยังเป็น 200 ให้ดูที่ `errorCode` |
| 400 | body ผิดรูปแบบ, ข้อมูลผิด (มี `problems` บอกทุกข้อ) หรือไม่มีรุ่นที่ขอ |
| 401 | ไม่มีหรือส่ง `X-API-Key` ผิด (เมื่อตั้ง `API_KEY`) |
| 404 | ไม่มี DRG ที่ขอ |
| 503 | คิวเต็ม (เกิน `MAX_QUEUE`) ให้ลองใหม่ตาม header `Retry-After` |
| 502 | grouper ทำงานผิดพลาด (ดู log) |
| 500 | ข้อผิดพลาดอื่นที่ไม่คาดคิด (ดู log) |

### 5.7 ตัวอย่างการเรียก

**Java 8** (ไม่ต้องเพิ่ม library):

```java
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class DrgApiClient {
    public static String group(String baseUrl, String apiKey, String caseJson) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(baseUrl + "/api/v1/group").openConnection();
        con.setRequestMethod("POST");
        con.setConnectTimeout(5000);
        con.setReadTimeout(30000);
        con.setDoOutput(true);
        con.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (apiKey != null && !apiKey.isEmpty()) {
            con.setRequestProperty("X-API-Key", apiKey);
        }
        try (OutputStream out = con.getOutputStream()) {
            out.write(caseJson.getBytes(StandardCharsets.UTF_8));
        }
        int status = con.getResponseCode();
        InputStream in = status < 400 ? con.getInputStream() : con.getErrorStream();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
        }
        if (status != 200) {
            throw new IOException("DRG API HTTP " + status + ": " + sb);
        }
        return sb.toString(); // แปลง JSON ด้วย library ที่โปรเจกต์ใช้อยู่ เช่น Gson หรือ Jackson
    }
}
```

ถ้าเรียกจากระบบที่บันทึกผลลงฐานข้อมูล ให้เรียก API ให้เสร็จก่อน แล้วค่อยเปิด transaction บันทึกผล อย่าเรียกระหว่างที่ transaction ยังเปิดค้างอยู่

**JavaScript / Node.js:**

```js
const res = await fetch('http://127.0.0.1:8089/api/v1/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sex: 1, dob: '1980-05-10', admitDate: '2024-01-10T08:30', dischargeDate: '2024-01-13T10:00', dischargeType: 1, pdx: 'K35.8', procedures: ['47.09'] }),
});
const r = await res.json();
console.log(r.drg, r.rw, r.adjrw);
```

**Python:**

```python
import requests
r = requests.post("http://127.0.0.1:8089/api/v1/group", json={
    "sex": 1, "dob": "1980-05-10", "admitDate": "2024-01-10T08:30",
    "dischargeDate": "2024-01-13T10:00", "dischargeType": 1,
    "pdx": "K35.8", "procedures": ["47.09"]}).json()
print(r["drg"], r["rw"], r["adjrw"])
```

---

## 6. รหัส Error และ Warning

**Error** (รายที่มี error ได้ DRG กลุ่ม 26xx9 คือ 26509, 26519 หรือ 26539):

| รหัส | ความหมาย |
|---|---|
| 1 | ไม่มี PDx |
| 2 | PDx ไม่ถูกต้อง (ไม่มีในตาราง) |
| 3 | PDx ใช้เป็นการวินิจฉัยหลักไม่ได้ |
| 4 | PDx ไม่เหมาะกับอายุ |
| 5 | PDx ไม่เหมาะกับเพศ |
| 6 | อายุผิดพลาด |
| 7 | จัดกลุ่มไม่ได้เพราะไม่มีข้อมูลเพศ (เมื่อต้องใช้เพศตัดสิน) |
| 8 | จัดกลุ่มไม่ได้เพราะประเภทการจำหน่ายผิด (เมื่อต้องใช้) |
| 9 | วันนอนผิดพลาด |
| 10 | จัดกลุ่มไม่ได้เพราะน้ำหนักแรกรับผิดหรือไม่มี (ทารก) |

**Warning** เป็น bit mask คือค่ารวมกันได้ เช่น 33 = 1 + 32

| bit | ความหมาย |
|---|---|
| 1 | SDx ใช้ไม่ได้ ซ้ำกับ PDx หรือซ้ำกันเอง |
| 2 | SDx ไม่เหมาะกับอายุ |
| 4 | SDx ไม่เหมาะกับเพศ หรือเป็นรหัสเฉพาะเพศแต่ไม่มีข้อมูลเพศ |
| 8 | Proc ใช้ไม่ได้ หรือซ้ำกันเอง |
| 16 | Proc ไม่เหมาะกับเพศ หรือเป็นรหัสเฉพาะเพศแต่ไม่มีข้อมูลเพศ |
| 32 | ไม่มีข้อมูลเพศ หรือใช้รหัสนอกเหนือที่กำหนด |
| 64 | ไม่มีประเภทการจำหน่าย หรือใช้รหัสนอกเหนือที่กำหนด |
| 128 | วัน/เวลารับไว้ไม่มีหรือไม่ถูกต้อง |
| 256 | วัน/เวลาจำหน่ายไม่มีหรือไม่ถูกต้อง |

รายการล่าสุดดูได้จาก `GET /api/v1/codes`

---

## 7. วิธีสร้างจากหนังสือ Thai DRG 6.3.3

### 7.1 ที่มาของข้อมูลแต่ละส่วน

| ส่วน | แหล่งที่มา | ไฟล์ในโปรแกรม |
|---|---|---|
| ICD-10: MDC, PDC, ใช้เป็น PDx ได้หรือไม่, ช่วงอายุ, เพศ, CC | ตาราง `c63i10.dbf` (6.3.4) | อ่านตรงจาก dbf |
| ICD-9-CM: OR procedure, ชนิด extension | ตาราง `c63proc.dbf` (6.3.4) | อ่านตรงจาก dbf |
| DRG: ชื่อ, RW, RW0d, WtLOS, OT, OF | ตาราง `c63drg.dbf` (6.3.4) | อ่านตรงจาก dbf |
| CC exclusion | ตาราง `c63ccex.dbf` (6.3.4) | อ่านตรงจาก dbf |
| หลักการจัดกลุ่ม, ERR/WARN, LOS, extension code, สูตร PCL | เล่ม 1 เนื้อหาหลัก | `src/native/engine.js` |
| คู่รหัส dagger/asterisk | เล่ม 1 ภาคผนวก A1 | `rules.json` (`dagger`) |
| หัตถการผสม | เล่ม 1 ภาคผนวก C | `rules.json` (`combos`) |
| AdjRW | เล่ม 1 ภาคผนวก H | `src/native/engine.js` |
| การกำหนด ICD-10/ICD-9-CM ให้ PDC ในแต่ละ MDC, รายการ AX | เล่ม 2 | `rules.json` (`dxPdc`, `procPdc`, `ax`) |
| นิยาม DC และ DRG แต่ละ PCL | เล่ม 2 | `rules.json` (`dcs`) |
| ลำดับการลอง DC ในแต่ละ MDC | แผนภูมิ MDC ในเล่ม 2 | `groupers/6.3.4/native/flow.json` (เขียนด้วยมือ อยู่ใน git) |
| DCL ของ SDx ในแต่ละ DC | ภาคผนวก F1 (`VSup11`–`VSup44`) | `rules.json` (`dcl`) |

ทำไมหนังสือ 6.3.3 แต่ตาราง 6.3.4:

- สรท. เผยแพร่หนังสือรุ่นล่าสุดเป็น 6.3.3
- รุ่น 6.3.4 แก้ไขตารางและโปรแกรม (TGrp6305) โดยใช้หลักเกณฑ์ตามหนังสือ 6.3.3
- ค่าที่อยู่ในตาราง (เช่น RW, CC exclusion) จึงใช้ของ 6.3.4 ส่วนนิยามที่มีเฉพาะในหนังสือใช้ของ 6.3.3

### 7.2 ขั้นตอนการจัดกลุ่ม

1. **ตรวจข้อมูล:**
   - คำนวณอายุและ LOS: นับวัน ถ้าเศษเกิน 6 ชั่วโมงนับเป็น 1 วัน แล้วหักวันลา
   - ตรวจ PDx (ERR 1–6)
   - ตรวจ SDx และ Proc (warning)
     - รหัสที่ถูกตัดเพราะอายุหรือเพศไม่ถูกนับว่าซ้ำในภายหลัง
2. **Extension code:** ตรวจความต่อเนื่องของครั้งที่ผ่าตัด แล้วนับจำนวนตำแหน่งและครั้ง
   - ใช้ตัดสินเงื่อนไข `>1` (ตำแหน่งรวมมากกว่า 1)
   - ใช้ตัดสินเงื่อนไข `*1` (มากกว่า 1 ครั้ง)
3. **หา MDC:** Pre-MDC (เช่น ปลูกถ่ายอวัยวะ) → MDC 24 (บาดเจ็บรุนแรงหลายระบบ) → MDC ของ PDx
   - ทารกอายุน้อยกว่า 28 วันเข้า MDC 15 และใช้น้ำหนักแรกรับ
4. **หา DC:** ลอง DC ตามลำดับใน `flow.json` คือ ผ่าตัด → Unrelated OR Procedure → อายุรกรรม
   - นิยาม DC เช่น `PDx as PDC 5A and Proc as AX 5PHX` ถูกแปลงเป็นฟังก์ชันใน `src/native/conditions.js`
5. **Reassignment:** ถ้า PDx ไม่เข้ากับหัตถการ (เช่น PDx ปอดอักเสบ แต่ผ่าตัดกะโหลก)
   - หา SDx ที่อยู่ใน MDC ของหัตถการมาใช้แทน
   - บอกรหัสที่ใช้แทนใน `pdxUsed`
6. **PCL:**
   - นำ DCL ของ PDx และ SDx มาเรียงจากมากไปน้อย แล้วตัดรหัสที่เข้า CC exclusion
   - รวมค่าแบบลดทอน: ตัวที่ k คูณ 0.82^k
   - ปัดเศษ และไม่เกิน 9
7. **DRG:** เลือก DRG ของ DC ตามช่วง PCL
8. **AdjRW (ภาคผนวก H):**
   - นอนไม่ถึง 24 ชั่วโมง ใช้ RW0d
   - นอนน้อยกว่า WtLOS/3 ใช้ค่าระหว่าง RW0d กับ RW
   - นอนเกิน OT บวกเพิ่มตามค่าที่กำหนด (แยกผ่าตัด/อายุรกรรม และระดับ RW)

จุดที่หนังสือไม่ได้เขียนไว้ชัด ใช้ผลเทียบกับ exe ตัดสิน และมีคอมเมนต์อธิบายในโค้ดทุกจุด

### 7.3 การสร้าง rules.json

`npm run setup` ทำให้อัตโนมัติ ถ้าต้องการทำเองทีละขั้น:

```sh
pdftotext -raw -enc UTF-8 TDrg633Vol1OneFinC.pdf text/TDrg633Vol1OneFinC.txt
# ทำซ้ำกับ TDrg633Vol2TwoFinC.pdf และ TDrg633VSup11FinC.pdf ... TDrg633VSup44FinC.pdf
node tools/build-rules.mjs text groupers/6.3.4/native/rules.json
```

- `build-rules.mjs` พิมพ์จำนวนรายการที่อ่านได้ (DCL, PDC ต่อ MDC, AX, DC, DRG) ให้ตรวจว่าครบ
- ผลลัพธ์ไม่มีวันเวลาอยู่ในไฟล์ ไฟล์ที่ได้จึงเหมือนเดิมทุกครั้งที่สร้างจากข้อความชุดเดิม
- ตรวจแล้วว่า xpdf `pdftotext` 4.06 และ poppler 26.01 ให้ไฟล์เดียวกัน (SHA-256 `268fc6a3…`)

### 7.4 เมื่อ สรท. ออกรุ่นใหม่

1. สร้างโฟลเดอร์ `groupers/<รุ่น>/` พร้อม `grouper.json`
2. ปรับ `tools/setup.mjs` (ชื่อไฟล์และ SHA-256) และ regex ใน `tools/build-rules.mjs` ถ้ารูปแบบหนังสือเปลี่ยน
3. ตรวจลำดับ DC ใน `native/flow.json` เทียบกับแผนภูมิ MDC ของหนังสือรุ่นใหม่
4. ถ้าตารางเปลี่ยนชื่อ (เช่น `c64*.dbf`) ให้ปรับชื่อไฟล์ใน `src/native/engine.js`
5. เทียบกับ exe รุ่นใหม่ด้วย `npm run compare` จนผลตรงกัน แล้วจึงเปิดใช้

---

## 8. ผลการทดสอบเทียบกับ TGrp6305.exe

### 8.1 วิธีทดสอบ

`tools/compare.mjs` สุ่มรายผู้ป่วยแบบสมจริง แล้วส่งชุดเดียวกันให้ทั้ง exe และโปรแกรมนี้ จากนั้นเทียบฟิลด์ `DRG`, `MDC`, `ERR`, `WARN`, `RW` และ `ADJRW`

ข้อมูลที่สุ่มครอบคลุม:

- PDx ที่ใช้เป็นการวินิจฉัยหลักได้ และ SDx ที่มี CC
- หัตถการใน MDC เดียวกันและต่าง MDC รวมถึง extension code
- อายุตั้งแต่ทารกแรกเกิดถึงผู้สูงอายุ
- ข้อมูลเสียบางส่วน: ไม่มีเพศ, ประเภทจำหน่ายผิด, เวลาหาย, PDx ผิด, รหัสซ้ำ

วิธีรัน (exe ไม่อยู่ใน repository ให้แตก `S0021.zip` ไว้ที่อื่นเอง):

```sh
npm run compare -- --exe-dir=<โฟลเดอร์ที่มี TGrp6305.exe> 5000 3 --show=20 --out=diff.json
```

- พารามิเตอร์คือ จำนวนราย, seed และรุ่น
- ทดสอบบน Windows 11
- บน Linux/macOS ใส่ `--launcher=wine` ได้ แต่ยังไม่ได้ทดสอบ

### 8.2 ผลล่าสุด

ทดสอบวันที่ 27 พฤศจิกายน 2026 กับตาราง 6.3.4 และ `rules.json` SHA-256 `268fc6a3…`

| seed | จำนวนราย | ตรงกัน | ต่างกัน | ร้อยละที่ตรง |
|---|---:|---:|---:|---:|
| 1 | 2,000 | 2,000 | 0 | **100%** |
| 2 | 3,000 | 2,999 | 1 | 99.97% |
| 3 | 5,000 | 5,000 | 0 | **100%** |
| 4 | 8,000 | 7,998 | 2 | 99.97% |
| 5 | 20,000 | 19,992 | 8 | 99.96% |
| **รวม** | **38,000** | **37,989** | **11** | **99.97%** |

รายที่ต่างกัน 11 ราย แบ่งเป็น 2 แบบ:

- 8 ราย: extension `+1X` ในกรณี reassign (หัวข้อ 8.3)
- 3 ราย: ยังหาสาเหตุไม่พบ (หัวข้อ 8.4)

### 8.3 ข้อจำกัดที่ทราบ: extension `+1X` ที่ไม่ถูกต้องในกรณี reassign

เกิดเมื่อมีครบทุกข้อ:

- PDx อยู่ใน MDC 5, 6, 8 หรือ 9
- ถูก reassign ไปใช้ SDx อื่น เช่น PDx I10 กับ SDx S02.81 และหัตถการ 01.24
- หัตถการมี extension ที่ไม่ถูกต้องรูปแบบ `+1X` (1 ตำแหน่ง ครั้งที่ 2 ขึ้นไป แต่ไม่มีครั้งที่ 1) เช่น `01.24+12`

ผลที่ต่างกัน:

- หนังสือเขียนว่าต้องตัด extension ที่ไม่ถูกต้องทิ้ง โปรแกรมนี้ทำตามนั้น
- exe บางครั้งนับเป็นหลายตำแหน่งหรือหลายครั้ง จึงได้ DC ผ่าตัดซ้ำ (เช่น 0112, 0113, 0801)

ได้ลองหลายรูปแบบแล้ว แต่ไม่พบกฎที่ exe ใช้อย่างสม่ำเสมอ:

- exe นับ `+12` แต่ไม่นับ `+22`
- exe นับ `(+12, +12)` แต่ไม่นับ `(+12, +13)`
- ใน MDC 4, 7, 10 และ 11 exe ไม่ทำแบบนี้

จึงคงไว้ตามหนังสือ ในข้อมูลจริงกรณีนี้เกิดเฉพาะเมื่อลงรหัส extension ผิด ควรแก้ที่การลงรหัส

### 8.4 รายที่ยังหาสาเหตุไม่พบ (seed 5)

| ราย | ข้อมูล | exe | โปรแกรมนี้ | ข้อสังเกต |
|---|---|---|---|---|
| #5613 | ไม่มีเพศ, PDx Z20.1, SDx H31.4 F31.31 E44.1 H73.0, Proc 20.61 07.00 78.63 54.19 | 10021 (MDC 10) | 03100 (MDC 03) | reassign เมื่อไม่มีเพศ exe เลือก MDC จาก SDx ต่างจากโปรแกรมนี้ |
| #13639 | อายุ 8 ปี, PDx T38.3, SDx I22.0 M86.90 P35.4, Proc 83.86 | 21041 (PCL 3) | 21040 (PCL 2) | T38.3 และ P35.4 อยู่ในตาราง CC exclusion ของกันและกัน แต่ exe ไม่ตัดตัวใดเลย |
| #19787 | PDx B20.5, SDx O31.1 P91.1 D68.2 M08.23 T67.0, Proc 71.62 54.11 78.51 | 21040 (MDC 21) | 08221 (MDC 08) | การ reassign ไป MDC 21 ของ exe |

ได้ลองเปลี่ยนกฎ CC exclusion ให้ไม่ตัด PDx แล้ว รายที่ต่างเพิ่มขึ้นหลายราย จึงคงกฎเดิมไว้

### 8.5 ข้อสังเกตอื่น

- **ไม่มีเพศ (ERR 7):** ถ้า SDx ที่ต้องตรวจตอน reassign อยู่มากกว่า 1 MDC (เช่น C76.3 อยู่ทั้ง MDC 12 และ 13) ทั้ง exe และโปรแกรมนี้ให้ ERR 7
- **รุ่นอื่น:** รองรับเฉพาะ 6.3.4 ถ้ายังต้องใช้รุ่น 5.1.1 หรือ 6.2.1 ให้ใช้โปรแกรมของ สรท.

---

## 9. การทดสอบ

```sh
npm test
```

| ไฟล์ | ทดสอบอะไร |
|---|---|
| `test/unit.test.js` | อ่าน/เขียน dbf, แปลงข้อมูลขาเข้า, อายุ, รหัส error/warning (ไม่ต้องใช้ข้อมูล สรท.) |
| `test/native.test.js` | API ทั้งชุด: ไส้ติ่ง, ทารก, ERR 2, extension code, reassign, ERR 7, batch 300 ราย, ข้อมูล DRG, API key, รุ่นที่ไม่มี, ข้อความเมื่อยังไม่ได้ setup |

- ถ้ายังไม่ได้รัน `npm run setup` ชุด `native.test.js` จะถูกข้าม
- ตั้ง `REQUIRE_DATA=1` เพื่อให้ล้มเหลวแทนการข้าม (CI ใช้แบบนี้)
- ผลล่าสุด: ผ่าน 20/20

CI (GitHub Actions) มี 3 งาน:

1. ทดสอบบน Node 20, 22, 24 โดยไม่มีข้อมูล สรท.
2. รัน `npm run setup -- --strict` แล้วทดสอบครบทุกข้อ
3. build Docker image แล้วเรียก `/health` และจัดกลุ่ม 1 ราย (ไม่ push image)

ทั้งสองงานไม่เผยแพร่ไฟล์ของ สรท. ออกไป

---

## 10. โครงสร้างโฟลเดอร์

```
thai-drg-grouper/
├─ src/
│  ├─ server.js          เริ่มบริการ
│  ├─ app.js             route, schema, OpenAPI
│  ├─ config.js          อ่าน .env
│  ├─ groupers.js        โหลดรุ่นต่าง ๆ, คิว
│  ├─ native/
│  │  ├─ engine.js       ขั้นตอนการจัดกลุ่ม
│  │  └─ conditions.js   แปลงนิยาม DC ในหนังสือเป็นฟังก์ชัน
│  ├─ input.js           แปลง JSON เป็น record
│  ├─ dbf.js, layout.js  อ่าน/เขียน dbf
│  └─ codes.js           รหัส error/warning
├─ groupers/6.3.4/
│  ├─ grouper.json       ชื่อรุ่นและรายการตาราง (ใน git)
│  ├─ native/flow.json   ลำดับ DC จากแผนภูมิในเล่ม 2 (ใน git)
│  ├─ native/rules.json  สร้างโดย npm run setup (ไม่อยู่ใน git)
│  └─ c63*.dbf           ดาวน์โหลดโดย npm run setup (ไม่อยู่ใน git)
├─ tools/
│  ├─ setup.mjs          ดาวน์โหลดไฟล์ สรท. และสร้างกฎ
│  ├─ build-rules.mjs    อ่านหนังสือเป็น rules.json
│  ├─ compare.mjs        เทียบผลกับ TGrp6305.exe
│  └─ exe/runner.js      ตัวรัน exe สำหรับ compare เท่านั้น
├─ test/
├─ cache/                ไฟล์ zip ที่ดาวน์โหลด (ไม่อยู่ใน git)
├─ Dockerfile, compose.yaml, .env.example
└─ LICENSE, NOTICE
```

---

## 11. ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `grouper 6.3.4: native/rules.json ... not found ... run "npm run setup" first` | ยังไม่ได้รัน `npm run setup` |
| `"pdftotext" was not found` | ติดตั้ง poppler-utils หรือ xpdf หรือใส่ `--pdftotext=<path>` |
| `S0021.zip from TCMC has checksum ...` | สรท. เปลี่ยนไฟล์บนเว็บ โปรแกรมนี้ตรวจแล้วเฉพาะไฟล์เดิม ให้ใช้ไฟล์เดิมใน `cache/` หรือเปิด issue |
| `cannot download ...` | เครื่องออกอินเทอร์เน็ตไม่ได้ ดาวน์โหลด zip ด้วยเบราว์เซอร์มาวางใน `cache/` แล้วรันใหม่ |
| `WARNING: rules.json is not the same as the build compared with TGrp6305.exe` | `pdftotext` รุ่นอื่นตัดบรรทัดต่างกัน ให้ลองรุ่นอื่น หรือเทียบผลด้วย `npm run compare` ก่อนใช้ |
| `400 unknown version` | รุ่นที่ขอไม่มี ดู `GET /api/v1/versions` |
| `looks like a Buddhist-era year` | ส่งวันที่เป็นปี พ.ศ. ให้แปลงเป็น ค.ศ. |
| ได้ ERR 10 ในทารก | ไม่ได้ส่ง `admitWeight` สำหรับอายุน้อยกว่า 28 วัน หรือส่งเป็นกรัม (ต้องเป็นกิโลกรัม) |
| ได้ ERR 7 | ไม่ได้ส่ง `sex` ในรายที่ต้องใช้เพศตัดสิน |
| ได้ ERR 9 พร้อม WARN 128/256 | ส่งวันที่โดยไม่มีเวลา ให้ใส่ `YYYY-MM-DDTHH:mm` หรือ `admitTime`/`dischargeTime` |
| 503 | คิวเต็ม ลดขนาดหรือความถี่ของคำขอ หรือเพิ่ม `MAX_QUEUE` |
| เครื่องอื่นเรียกไม่ได้ | ตั้ง `HOST=0.0.0.0` (Docker: `DRG_BIND=0.0.0.0`), เปิด firewall และตั้ง `API_KEY` |

---

## 12. เอกสารอ้างอิง

| เอกสาร | ลิงก์ |
|---|---|
| สำนักพัฒนากลุ่มโรคร่วมไทย (สรท.) | <https://www.tcmc.or.th> |
| หน้า Thai DRG ของ สรท. (หนังสือและโปรแกรม) | <https://www.tcmc.or.th/tdrg> |
| หนังสือ Thai DRG Version 6.3.3 เล่ม 1 และเล่ม 2 (`S0062.zip`) | <https://www.tcmc.or.th/_content_images/download/fileupload/S0062.zip> |
| หนังสือ Thai DRG Version 6.3.3 ภาคผนวก F (`S0063.zip`) | <https://www.tcmc.or.th/_content_images/download/fileupload/S0063.zip> |
| โปรแกรม TGrp6305 / Thai DRG 6.3.4 พร้อมตาราง (`S0021.zip`) | <https://www.tcmc.or.th/_content_images/download/fileupload/S0021.zip> |
| poppler (`pdftotext`) | <https://poppler.freedesktop.org> |
| xpdf (`pdftotext`) | <https://www.xpdfreader.com> |
| Apache License 2.0 | <https://www.apache.org/licenses/LICENSE-2.0> |

SHA-256 ของไฟล์ที่ใช้ทดสอบ (ตรวจอัตโนมัติใน `tools/setup.mjs`):

| ไฟล์ | SHA-256 |
|---|---|
| `S0021.zip` | `014f33ec603b59d548c0d815efa3c49280ac7fcd09d0ee95d3a7e0cc45b02630` |
| `S0062.zip` | `0ea85876046970be3ed20c83c336e96e0c98527b4f52f39be02e706b0fd9194a` |
| `S0063.zip` | `69df7ee797662e0231e23b9d1c54ccefd51bab5c9f76c82c547419c263cbfa15` |
| `rules.json` ที่สร้างได้ | `268fc6a36250de3a3256d215e60c5203013bb7c4a3eaa5eebd253f1364729c68` |

---

## 13. สัญญาอนุญาตและข้อควรทราบ

- โค้ดใน repository นี้ใช้สัญญาอนุญาต [Apache License 2.0](LICENSE)
- หลักเกณฑ์ Thai DRG, หนังสือ, ตาราง `c63*.dbf` และโปรแกรม `TGrp*.exe` เป็นงานของ **สำนักพัฒนากลุ่มโรคร่วมไทย (สรท./TCMC)**
  - สัญญาอนุญาตของ repository นี้ไม่ครอบคลุมงานเหล่านั้น
  - การนำไปใช้ต้องเป็นไปตามเงื่อนไขของ สรท.
  - ดูรายละเอียดใน [NOTICE](NOTICE)
- ไม่ได้ถอดรหัส (decompile) หรือแกะโปรแกรม exe: exe ใช้เป็นตัวเทียบผลแบบกล่องดำเท่านั้น
- โครงการนี้ไม่ได้จัดทำหรือรับรองโดย สรท.
- ก่อนนำผลไปใช้เบิกจ่ายจริง ควรเทียบกับโปรแกรมทางการของ สรท. บนข้อมูลของโรงพยาบาลเองก่อน

การร่วมพัฒนาดูที่ [CONTRIBUTING.md](CONTRIBUTING.md) และการแจ้งช่องโหว่ดูที่ [SECURITY.md](SECURITY.md)
