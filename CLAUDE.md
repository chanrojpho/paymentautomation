# TWD Auto Billing V2 — Project Context

> วางไฟล์นี้ไว้ที่ root ของ repo `paymentautomation` — Claude Code อ่านอัตโนมัติทุกครั้งที่เปิดโปรเจกต์

---

## โปรเจกต์คืออะไร

Mobile web app (single HTML file) สำหรับส่งสลิปโอนเงินไปยังระบบ **ตะวันแดง DCM** อัตโนมัติ
ลด manual data entry ด้วย AI อ่านบิล (Claude Sonnet 4.6) + store lookup อัตโนมัติ
ภาษาหลักของ UI: **ไทย** | Mobile-first (iPhone primary) | ธีม: แมวเปอร์เซียขาว 🐱

---

## โครงสร้างไฟล์

| ไฟล์ | คืออะไร | Deploy ยังไง |
|---|---|---|
| `index.html` | Frontend ทั้งหมด (HTML/CSS/JS ในไฟล์เดียว) | push GitHub → GitHub Pages อัปเดตอัตโนมัติ |
| `Code_V2.gs` | Google Apps Script backend | **copy ไป paste บน script.google.com เอง — push ไม่ได้** |

⚠️ **สำคัญ:** `Code_V2.gs` ใน repo เป็นแค่ reference/backup. ตัวจริงรันอยู่บน Google Apps Script. แก้แล้วต้อง copy ไป paste + Deploy → New version เอง

---

## Backend & Keys

| Item | Value |
|---|---|
| GAS URL | `https://script.google.com/macros/s/AKfycbxaaA7cVhsExjQEEFW8jA-CDt_cufi_VL3lUFcOugf6NJQ7qTqN5WuNhaVEzdUrPTI/exec` |
| Google Sheet ID | `14kqAxF338HWS_xBxugs7i5Gq8nlfn8ttp37VyLmkg8s` |
| Sheet tabs | `Pending` / `Bill Upload` / `Overdue Upload` |
| ตะวันแดง submit slip | `https://n8n-01.carabao.co.th/api/submit-delivery-form` |
| ตะวันแดง submit overdue | `https://n8n-01.carabao.co.th/api/submit-overdue-form` |
| ตะวันแดง store search | `https://n8n-01.carabao.co.th/api/store-search` (returns JSONP — GAS strips wrapper) |
| GitHub repo | `chanrojpho/paymentautomation` → https://chanrojpho.github.io/paymentautomation/ |
| Anthropic API Key | เก็บใน `Code_V2.gs` เท่านั้น (ไม่อยู่ใน HTML) |

---

## Architecture

```
Phone (GitHub Pages HTML)
      ↓ JSON + base64 image
Google Apps Script (GAS) — middleware
      ├── readBill  → Anthropic API (Sonnet 4.6) อ่านบิล
      ├── readSlip  → Anthropic API (Sonnet 4.6) อ่านยอดสลิป
      ├── storeSearch → ตะวันแดง store-search (strip JSONP)
      ├── savePending → Sheet tab Pending
      ├── updateStatus → แก้ status ใน Pending
      ├── getPending → ดึงรายการทั้งหมด
      ├── saveHistory → Sheet tab Bill Upload
      ├── saveOverdue → Sheet tab Overdue Upload
      └── (default POST) submit slip → ตะวันแดง
```

**ทำไมต้องมี GAS คั่นกลาง:**
- ตะวันแดงมี Cloudflare บล็อก browser submit ตรงๆ
- store-search return JSONP → GAS แปลงเป็น JSON
- แก้ CORS (iPhone file:// origin โดนบล็อก)
- ซ่อน Anthropic API key ฝั่ง server

---

## Workflow V2 (Proactive — ต่างจาก V1)

V1 = reactive (รอลูกค้าจ่ายก่อนถึงถ่ายบิล+สลิป)
**V2 = proactive** (register บิลทุกร้านก่อนตั้งแต่เช้า แล้วค่อย match สลิป/overdue ทีหลัง)

```
เช้า → เพิ่มบิลทุกร้าน (AI อ่าน หรือกรอกเอง)
              ↓
      Dashboard "Pending"
              ↓
    ┌─────────┴─────────┐
ลูกค้าจ่าย           ไม่จ่าย
อัปสลิป            ค้างชำระ
    ↓                  ↓
  paid             overdue
                       ↓ (จ่ายทีหลัง)
                  overdue_paid
```

---

## Status Flow

```
pending → paid          (จ่ายตรงเวลา → อัปสลิป)
pending → overdue       (ไม่จ่าย → mark ค้างชำระ)
overdue → overdue_paid  (ค้างแล้วจ่ายทีหลัง → กดปุ่ม "รับเงินแล้ว" → อัปสลิป)
```

**Dashboard 3 tabs:**
- ⏳ **Pending** — status = `pending`
- ✅ **Paid** — status = `paid` + `overdue_paid` (chip ต่างสี: ✅ vs 💛 Overdue Paid)
- 😿 **Overdue** — status = `overdue` เท่านั้น (มีปุ่ม "💛 รับเงินแล้ว")

---

## Sheet: Pending tab columns

| # (A) | Store Code (B) | Store Name (C) | DC (D) | Bill Amount (E) | Invoice Date (F) | Status (G) | Created At (H) | Updated At (I) | Overdue Days (J) | Staff (K) | Slip Ref (L) |
|---|---|---|---|---|---|---|---|---|---|---|---|

- Invoice Date = Delivery Date (วันเดียวกัน — ตอน submit slip ส่ง `delivery_date = invoice_date`)
- Status values: `pending` / `paid` / `overdue` / `overdue_paid`
- **Overdue Days (J)** = จำนวนวันที่ตั้งให้ ตอน mark/extend overdue → payment due date = Invoice Date + Overdue Days
- **Staff (K)** = ผู้ดูแลบิล (ใช้ filter reminder email — match ถ้า cell มีคำว่า "จี๋" หรือ "จันโรจน์")
- **Slip Ref (L)** = เลขอ้างอิงสลิปที่จ่ายแล้ว (ใช้ตรวจสลิปซ้ำ/ผิดบิล — wrong-slip guard)
- ⚠️ **Invoice Date cell เก็บเป็น Date object จริง ไม่ใช่ string** — Sheets auto-convert "YYYY-MM-DD" เป็นวันที่ ตอนอ่านฝั่ง GAS ต้องใช้ `toDateMid()` (ห้าม regex YYYY-MM-DD ตรงๆ จะ parse ไม่ได้)

---

## DC options (ศูนย์กระจายสินค้า)
`วัดกู้` / `บางพลี` / `พระราม 3` / `ชลบุรี` / `เชียงใหม่`

ตอน AI อ่าน dc_name มาจากบรรทัด `พนักงานขาย: Delivery SSS DC <ชื่อ>` ในบิล

---

## Staff data (สำหรับ overdue form)
```js
const STAFF_DATA = {
  'จันโรจน์': {
    fullName: 'จันโรจน์ พงศ์อายุกูล',
    nickname: 'จี๋',
    position: 'CEO Office',
    area: 'ตะวันออก',
    lineId: 'juggajejee'
  }
};
```

---

## 6 Features ล่าสุดที่ทำใน V2 (เสร็จแล้ว)

1. **เพิ่มบิล** — อัปรูปแล้ว AI อ่านอัตโนมัติทันที (ไม่มีปุ่ม "AI อ่านบิล") + ค้นหาชื่อร้านจากตะวันแดงให้เลย → เด้งไปหน้า summary
2. **Step 2 = summary card** อ่านอย่างเดียว + ปุ่ม ✏️ แก้ไข (มุมขวาบน) / 💾 บันทึกเลย (กด 1 tap ถ้า AI อ่านถูก)
3. **Tabs** — Pending / Paid / Overdue
4. **Overdue card** — ปุ่ม 💛 รับเงินแล้ว → อัปสลิป → status เป็น `overdue_paid`
5. **Status** — pending / paid / overdue / overdue_paid
6. **Paid tab** — แสดงทั้ง paid (✅) + overdue_paid (💛)

---

## Features เพิ่มเติม (2026-06-30)

### Wrong-slip guard (อัปสลิป)
ตอนอัปสลิป AI อ่าน `amount` + `reference` (เลขอ้างอิง) + `date` (วันโอน) — soft warnings (ไม่ block):
- **A) สลิปซ้ำ** — ถ้า reference เดิมถูกใช้กับบิลอื่นแล้ว เตือน + confirm ก่อนส่ง (กัน same-amount mix-up)
- **C) วันที่** — เตือนถ้าวันโอนก่อนวันส่งของ
- **Pairing line** — โชว์ว่าสลิปนี้กำลังแนบกับบิลไหน (ร้าน/วันส่ง/ยอด vs ref/วันโอน) ให้ตาเช็ค
- reference เก็บใน Pending col L (`Slip Ref`) ผ่าน action `setSlipRef`; client เช็คซ้ำจาก `dashboardData.all`
- frontend degrade ได้: ถ้า GAS เก่ายังไม่ deploy → readSlip คืนแค่ amount → guard เงียบ (ไม่ error)

### Nightly reminder email (GAS-only, ไม่ผ่าน web app)
- `sendPendingReminder()` — รันโดย time-trigger ~21:45 (Asia/Bangkok) email จี๋ บิลค้าง
- รวม **pending ทั้งหมด** + **overdue ที่ count เก่า** (due = Invoice+OverdueDays < วันนี้) เท่านั้น; ที่ extend คุมวันนี้แล้วไม่ส่ง
- config ด้านบนไฟล์: `REMINDER_EMAIL`, `REMINDER_STAFF`, `REMINDER_STATUSES`
- setup ครั้งเดียว: `authorizeScopes()` (กด Allow — mail+scriptapp) → `installReminderTrigger()`
- ⚠️ try/catch ใน `sendPendingReminder` กลืน auth error → ต้องใช้ `authorizeScopes()` (ไม่มี try/catch) เพื่อให้ consent dialog เด้ง
- ดู trigger ที่ ⏰ Triggers ใน editor; ไม่ต้อง Deploy New version (trigger ใช้ saved script)

## Key JS functions (index.html)

| ส่วน | Functions |
|---|---|
| Dashboard | `loadDashboard()`, `renderPendingList()`, `renderPaidList()`, `renderOverdueList()`, `switchHomeTab()` |
| เพิ่มบิล | `abHandleBillFile()` (auto-read), `abReadBillWithAI()`, `abShowSummary()`, `abShowEdit()`, `abApplyEdit()`, `abSavePending()`, `abGoManual()`, `abSearchStore()`, `abLookupStoreName()` |
| อัปสลิป | `startPaySlip(item, fromOverdue)`, `psHandleSlip()`, `psReadSlipAmount()` (cross-check), `psRunSlipChecks()` + `psFindDupSlip()` (wrong-slip guard), `psSubmit()` |
| ค้างชำระ | `startOverdue()`, `ovFillStaff()`, `ovCalcDue()`, `ovSubmit()` |
| Helpers | `fmtDate()`, `fmtTime()`, `fmtAmt()`, `nowStamp()`, `showStatus()` |

---

## Code Style / Conventions
- Single HTML file, no framework, no build step
- CSS variables ทั้งหมด (ธีมแมวเปอร์เซีย) — ดู `:root {}`
- Font: Sarabun + Mitr
- ไม่ใช้ localStorage — Google Sheet คือ single source of truth
- ภาพ compress 1200px / JPEG 75% ก่อนส่ง (iPhone fix)
- ทุก AI call ผ่าน GAS เท่านั้น (ซ่อน API key)
- ประวัติ Dashboard แสดง 3 วันย้อนหลัง (paid/overdue)

---

## ข้อควรระวังเวลาแก้

1. แก้ `Code_V2.gs` → ต้อง copy ไป paste บน script.google.com + Deploy → New version (push อย่างเดียวไม่พอ)
2. status logic อยู่ฝั่ง HTML ทั้งหมด — GAS แค่ get/save ตาม param
3. `getPending` return key `#` (column #) → ใช้ `item['#']` หรือ fallback `item._row`
4. แก้ HTML → push → รอ GitHub Pages build 1-2 นาที
5. เทสบนมือถือจริง (iPhone) เพราะ camera + compression behavior ต่างจาก desktop
6. **วันที่ใน Sheet เป็น Date object** — ฝั่ง GAS อ่านวันที่ต้องใช้ `toDateMid()` (regex `^\d{4}-\d{2}-\d{2}` จะ fail เพราะ cell คืน Date ไม่ใช่ string)
7. **reminder/trigger ไม่ต้อง Deploy New version** (รัน saved script) — แต่ slip-guard (readSlip/setSlipRef) **ต้อง** Deploy New version ถึงจะมีผลกับ frontend
8. แก้ฟังก์ชันที่ใช้ scope ใหม่ (mail ฯลฯ) ถ้า consent ไม่เด้ง → รัน `authorizeScopes()` (ไม่มี try/catch) ให้ dialog โผล่
