# CHEM-IMMUNO CBH — แผนพัฒนาระบบคลัง Clinical Chemistry และ Clinical Immunology

**เอกสารเป้าหมาย:** `D:\Claude workspace\CHEM-IMMUNO-QMS\docs\CHEM-IMMUNO-CBH-INVENTORY-IMPLEMENTATION-PLAN.md`  
**สถานะ:** เอกสารแผนที่อนุมัติ ใช้เป็นข้อกำหนดหลักสำหรับการพัฒนา Phase 1

## 1. Executive summary, scope และหลักฐานอ้างอิง

สร้างแอปใหม่ชื่อ **CHEM-IMMUNO CBH** ด้วย Next.js 16, React 19, TypeScript, Supabase และ Vercel ใช้คลังตรรกะสองแห่งคือ `CLINICAL CHEMISTRY` กับ `IMMUNOLOGY` บน inventory engine เดียว โดยแยกสิทธิ์และข้อมูลถึงระดับฐานข้อมูล งานหลักคือ Product Master, ความสัมพันธ์สินค้า, การรับเข้า, LOT/expiry, การเบิก, ledger, การตรวจนับ, reorder, vendor และรายงาน ส่วน PWA/ไอคอนเป็นงานสนับสนุนช่วงท้าย

**นอกขอบเขต:** IQC, EQA, calibration management, method verification/validation, CAPA, equipment PM, document control และ patient/test-result workflows การเบิกเพื่อ QC หรือ Calibration เป็นเพียง *purpose ของ stock issue* ไม่ใช่การสร้างโมดูล QMS เหล่านั้น

รีโป GitHub `nicssj-world/CHEM-IMMUNO-QMS` เข้าถึงได้ แต่ยังไม่มี commit; โฟลเดอร์เป้าหมายยังว่าง ขั้นตอนเริ่มงานจริงคือ clone รีโป ตรวจ `origin` แล้วตั้งโครงสร้างโปรเจกต์ **ก่อน** พัฒนา ใช้ Stock-BM ที่ HEAD `94e290b69c8e68d73e430b37322736da481e9858` แบบ read-only เท่านั้น สิ่งที่นำมาเป็นแนวคิด ได้แก่ signed movement ledger และ reversal, invoice/receipt แยกกันสำหรับ partial receiving, parser GS1/HIBC ที่เก็บ AI 240 แยกจาก REF, Ephis ID กับ Supabase Auth, และ vendor evaluation ที่ไม่คำนวณคะแนนเมื่อ policy ยังไม่อนุมัติ โครงสร้าง `bm_*`, `nipt_users`, สิทธิ์ และกฎธุรกิจของ Stock-BM ไม่ถูกคัดลอกมาใช้ตรง ๆ

### ผลตรวจ workbook ใหม่

ตรวจเฉพาะ `NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx` (SHA-256 `5DC4FEA985E8A262177E96F317BB56D1A0E0F5DDFE660EB2E75005DE355B788C`) โดยนับเฉพาะแถวสินค้าจริง ไม่รวมส่วนหัว/หัวหมวด ชีตน้ำยาให้ชนิด `reagent` จากชื่อชีต; ชีต FOC ใช้ค่า `Type` ในแต่ละแถว ไม่ใช้ไฟล์เก่า :codex-file-citation{path="C:/Users/User/Downloads/NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx" purpose="source" artifact_kind="workbook" sheet="Reagent list" range="A4:F78"} :codex-file-citation{path="C:/Users/User/Downloads/NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx" purpose="source" artifact_kind="workbook" sheet="FOC item_chem c503 c703 ISE" range="A4:G53"} :codex-file-citation{path="C:/Users/User/Downloads/NEW Summary_72 items + FOC_Chonburi_revised 2026_20092026.xlsx" purpose="source" artifact_kind="workbook" sheet="FOC item_Imm e801" range="A4:G47"}

| คลัง | Reagent | Calibrator | Control | Consumable | รวม |
|---|---:|---:|---:|---:|---:|
| Chemistry | 42 | 11 | 10 | 27 | **90** |
| Immunology | 30 | 21 | 13 | 8 | **72** |
| **รวม** | **72** | **32** | **23** | **35** | **162** |

จำนวนรวม **ตรง** กับสมมติฐาน 72 น้ำยา + 90 FOC ใน prompt แต่การกระจายตามคลังและชนิดข้างต้นเป็นผลตรวจจริง ทุกแถวมี REF ปัจจุบันและ manufacturer barcode เป็นข้อความ; REF ทั้ง 162 ค่าและ barcode ทั้ง 162 ค่าไม่ซ้ำกัน ค่า REF 138 รายการขึ้นต้นด้วย `0` จึงต้องรักษาศูนย์นำหน้า ไม่มีชื่อสินค้าซ้ำแบบตรงตัวหรือ legacy REF ที่ชนกับ REF ปัจจุบัน

การอ่าน `Used with` แบบจับคู่รหัสน้ำยา Chemistry หรือชื่อเต็ม Immunology ที่ตรงอย่างกำหนดแน่ชัดให้ **90 คู่ Product→Product** จาก FOC 51 แถว: Chemistry 60 คู่, Immunology 30 คู่ อีก **27 แถว Product→Platform/Analyzer** ระบุระบบเครื่อง: Chemistry 20 แถวเป็นกลุ่ม `c503 / c703 / ISE`, 2 แถว `ISE neo`, 1 แถว `c703`; Immunology 4 แถว `e801` จำนวน 27 นี้คือความสัมพันธ์ที่ระบุใน `Used with` เท่านั้น; หัวหมวดของน้ำยา 72 แถวเป็นหลักฐานระดับกลุ่ม ไม่ใช่การยืนยันว่าแต่ละน้ำยาใช้ได้กับเครื่องทุกตัวในกลุ่ม ห้ามขยายกลุ่มเป็นหลาย edge โดยอัตโนมัติ

**REF ปัจจุบัน ← REF เดิม ทั้ง 29 คู่จาก Remark** (26 Chemistry, 3 Immunology):

- Chemistry `No. 3–17`: `08056757214←08056757190`; `08104697214←08104697190`; `08104719214←08104719190`; `08058652214←08058652190`; `08056951214←08056951190`; `10421436190←08056960190`; `08057800214←08057800190`; `08058806214←08058806190`; `08057524214←08057524190`; `08057443214←08057443190`; `08058687214←08058687190`; `08057877214←08057877190`; `08057966214←08057966190`; `04880455214←04880455190`; `08057494214←08057494190`.
- Chemistry `No. 19–38`: `08056811214←08056811190`; `08057958214←08057958190`; `08057460214←08057460190`; `08057796214←08057796190`; `08057931214←08057931190`; `08058776214←08058776190`; `08058750214←08058750190`; `08057427214←08057427190`; `08058016214←08058016190`; `08058610214←08058610190`; `09529713190←08056668190`.
- Immunology `No. 48, 61, 69`: `09043284214←09043284190`; `09015124214←09015124190`; `07251025214←07251025190`.

เก็บ REF เดิมเป็น identifier ของ **สินค้าเดิม** ทั้ง 29 รายการ ไม่สร้าง product เพิ่ม และไม่แปลงเป็นความสัมพันธ์ `replacement_for` ระหว่างสอง Product

**Review queue ของ `Used with` ทั้ง 12 แถวที่ยังยืนยันไม่ได้** — เลขแถวคือแถว Excel จริง:

| ชีต / แถว (`No.`) | สินค้า | เหตุผลที่ต้องทบทวน |
|---|---|---|
| Chemistry FOC 16 (`12`) | A1CD | `A1CX4 (hemolysing reagent)` มีข้อความกำกับเพิ่มเติม |
| Chemistry FOC 17 (`13`) | START | `ALBT2 (start reagent)` มีข้อความกำกับเพิ่มเติม |
| Immunology FOC 5 (`47`) | proBNP II CS | `Used with` มี `(485)` เพิ่มจากชื่อน้ำยา |
| Immunology FOC 6 (`48`) | Troponin T hs CS | `Used with` มี `(164)` เพิ่มจากชื่อน้ำยา |
| Immunology FOC 10 (`52`) | FT4 IV CALSET | ข้อความ `FT4 IV E801 (300 TESTS)` ไม่ตรงชื่อน้ำยา |
| Immunology FOC 26 (`68`) | DILUENT UNIVERSAL | proBNP มี `(485)` เพิ่ม |
| Immunology FOC 27 (`69`) | DILUENT MULTI ASSAY | Troponin มี `(164)` เพิ่ม |
| Immunology FOC 34 (`76`) | PRECICONTROL CARDIAC | proBNP มี `(485)` เพิ่ม |
| Immunology FOC 35 (`77`) | PRECICONTROL TROPONIN | Troponin มี `(164)` เพิ่ม |
| Chemistry FOC 41 (`37`) | COBAS SAMPLE CUP | `Used with` ว่าง |
| Chemistry FOC 42 (`38`) | RD STANDARD FALSE BOTTOM TUBE | `Used with` ว่าง |
| Immunology FOC 33 (`71`) | PROGESTERONE DILUENT | `Used with` ว่าง |

**ข้อผิดปกติอื่นที่ต้องอยู่ในรายงาน import:** `Packing Size` ว่าง 3 แถว ได้แก่ Chemistry FOC 15 (`PRECISET TDM I CALIBRATOR`), Chemistry FOC 42 (`RD STANDARD FALSE BOTTOM TUBE`) และ Immunology FOC 33 (`ELECSYS PROGESTERONE DILUENT`); Immunology FOC 38 (`HCV Duo PC`) มีข้อความ `10 x 1.0 mL, 5 x 2.0 m` ที่ดูเหมือนหน่วยท้ายถูกตัด เลข `No.` ไม่เป็น unique key: ซ้ำระหว่างชีตน้ำยากับ FOC และเลข 47/48 ซ้ำระหว่างสองชีต FOC; Immunology `No. 71` อยู่หลัง `No. 75` ในลำดับแถว นอกจากนี้ Chemistry FOC 39 ชื่อ `Reaction Cell c 503 / c513` แต่ `Used with` ระบุ `c503 / c703 / ISE`; `STANDARDS HIGH/LOW` ถูกจัดเป็น consumable และ `ISE INTERNAL STANDARD GEN.2` อยู่ในชีต reagent ให้คงค่าต้นทางและส่งตรวจความหมาย ห้ามแก้ชนิดหรือความเข้ากันได้จากชื่อสินค้าเอง

## 2. แบบจำลองสินค้า ผู้ใช้ และข้อมูลคลัง

**Product Master และ identifiers.** `ci_products` มี warehouse, Product Code, `source_name`, `display_name`, product type, packing text, stock unit, สถานะ และ provenance (`batch/sheet/row/raw snapshot`) เก็บ REF, legacy REF, manufacturer barcode, GTIN, HIBC PCN, GS1 AI 240 และ identifier อื่นใน `ci_product_identifiers` พร้อมชนิดและหลักฐาน แยกความหมายของแต่ละชนิด; barcode 9 หลักใน workbook **ไม่ถูกสมมติว่าเป็น GTIN** `source_name` ไม่เปลี่ยน, `display_name` แก้ไขภายหลังได้ สินค้าที่มีประวัติ LOT, invoice หรือ ledger แล้วปิดใช้งานแทน hard delete; สินค้าที่ไม่มี operational reference จึงอนุญาต hard delete หลังตรวจ dependency และบันทึก audit

Product Code ออกโดยฐานข้อมูลผ่าน counter สองแถวที่ lock ใน transaction (`CHE`, `IMM`) ไม่รับค่าจากผู้ใช้ ไม่ใช้ `MAX+1` และไม่ใช้ Excel `No.` เป็น key ลำดับ import ที่เลือกคือ **น้ำยาตามแถวจริงก่อน แล้ว FOC ตามแถวจริงภายในแต่ละคลัง** หลังผ่าน gate ข้อมูลปัจจุบันจะได้ `CHE-0001…CHE-0090` และ `IMM-0001…IMM-0072`; code ที่ commit แล้วไม่เปลี่ยนและไม่ใช้ซ้ำแม้ลบสินค้า

**Relationships และ platforms.** `ci_product_relations` เก็บทิศทางจาก reagent ไปวัสดุที่ใช้ พร้อม `uses_calibrator`, `uses_control`, `uses_consumable`, `compatible_with`, `replacement_for`, `other` และ note ฐานข้อมูลตรวจ target type, ห้าม self-reference และห้ามข้ามคลัง; UI ใช้ searchable selector ที่กรอง target ตามชนิด/คลัง เพิ่ม แก้ เปลี่ยนชนิด และ hard delete ได้โดยบันทึก audit ส่วน `ci_platforms` กับ `ci_product_platforms` เก็บเครื่อง/กลุ่มเครื่องแยกจาก Product relation ข้อความ `Used with` ที่ไม่ตรงต้องอยู่ review queue; mapping ที่อนุมัติถูกบันทึกเป็น manifest `source text → verified target` ไม่มี fuzzy auto-link ใน Production

**Warehouse และผู้ใช้.** ทุก Product, location, LOT, receipt, movement, count และการคำนวณผูก `warehouse_id`; invoice header เดียวข้ามคลังได้ แต่ invoice line และ receipt แยกคลังตาม Product ใช้ composite foreign keys และ validation ป้องกันการจับ Chemistry product กับ Immunology location ตั้งแต่ฐานข้อมูล `ci_user_access` ผูก Supabase Auth UUID กับ Ephis ID, สถานะ และสิทธิ์ต่อคลัง ผู้ใช้เห็นเฉพาะคลังที่ได้รับมอบหมาย; หน้าเว็บกับ server/database ตรวจสิทธิ์ซ้ำกัน

| Role | สิทธิ์หลัก |
|---|---|
| Admin | จัดการผู้ใช้และ master ทั้งหมด, อนุมัติ import, ปรับยอด/ย้อนรายการ, ดู audit |
| Supervisor | ดูแล master/identifier mapping, อนุมัติ count, ปรับยอด/ย้อนรายการและงาน vendor ในคลังที่ได้รับสิทธิ์ |
| Staff | รับเข้า เบิก ย้ายภายในคลัง บันทึกยอดตรวจนับ และเสนอ barcode mapping |
| Viewer | อ่าน dashboard, stock และรายงานในคลังที่ได้รับสิทธิ์ |

Ephis ID เป็นชื่อสำหรับเข้าระบบ แต่ Supabase Auth เป็นผู้ยืนยันตัวตน; รูปแบบการ provision บัญชี/การผูก Ephis ID ต้องได้รับการยืนยันก่อนเปิดใช้จริง ไม่สันนิษฐานว่าจะใช้ `nipt_users` หรืออีเมล alias ของ Stock-BM

## 3. งานคลังและประสบการณ์ใช้งาน

**Ledger และธุรกรรม.** ยอดคงเหลือคือผลรวม signed movement ของ LOT × location จาก `ci_stock_movement_lines` ไม่มีช่องแก้ balance เอง Transaction ที่ confirm แล้วและ movement ถูกป้องกัน UPDATE/DELETE ด้วยสิทธิ์และ trigger รายการ `receive`, `issue`, `transfer`, `adjustment`, `reversal`, `expired_disposal` เก็บ actor, เวลา, เหตุผล และ idempotency key ธุรกรรมฐานข้อมูล lock LOT ที่เกี่ยวข้องตามลำดับคงที่ คำนวณ balance ใหม่ใต้ lock และปฏิเสธยอดติดลบ; unique idempotency key ป้องกัน double tap/retry และทุกหัวรายการ/line/audit commit หรือ rollback พร้อมกัน

**Receiving.** Phase 1 รองรับ invoice/receipt แบบกรอกข้อมูลและ partial receiving; Phase 2 เพิ่มถ่ายภาพใบกำกับ, barcode และ receipt assessment Invoice หนึ่งใบมี vendor, invoice number/date, PO number เมื่อมี, รูปเอกสารใน private Supabase Storage และ line ได้ทั้งสองคลัง ระบบแยก receipt ตาม warehouse โดยอัตโนมัติ แต่ผู้ใช้ไม่ต้องสร้าง invoice ซ้ำ แต่ละ line ต้องมี Product, จำนวน, LOT, expiry และ location; ตรวจยอดรับสะสมเทียบ invoice line ระหว่าง confirm พร้อมบันทึก discrepancy ภาพ/ผลสแกนเป็นข้อเสนอใน draft เท่านั้น การ confirm จึงเขียน ledger แบบ atomic

**Barcode.** ปรับแนวคิด parser ของ Stock-BM สำหรับ GS1-128, GS1 DataMatrix, HIBC DataMatrix และ HIBC Code 128 เก็บ raw payload และ symbology; แยก GTIN (AI 01), LOT (10), expiry (17), serial (21), AI 240, HIBC primary/secondary และ parse warnings AI 240/HIBC PCN ไม่ถูกคัดลอกเป็น REF เอง การจับคู่ Product ใช้ identifier ที่อนุมัติและไม่ขัดกันเท่านั้น หากไม่พบ แสดง `ไม่พบสินค้าที่ตรงกับ Barcode`, ให้ค้น Product และใช้ใน draft ได้; Staff เสนอ mapping ส่วน Supervisor/Admin ยืนยันก่อนเก็บ identifier ถาวร จากนั้นสแกนครั้งถัดไปจึง resolve ได้ Camera บน iPhone ต้องทำงานผ่าน HTTPS, มีทางเลือกพิมพ์/วางรหัสเมื่อกล้องหรือ decoder ใช้ไม่ได้ และรองรับการสแกนหลายกล่องต่อเนื่องโดยไม่ออกจาก flow

**Issue, FEFO และการแก้ไข.** หน้าจอเบิกแนะนำ LOT ที่ยังไม่หมดอายุและใกล้หมดอายุก่อนจากยอดที่มีจริง; เลือก LOT อื่นต้องมีเหตุผลและตรวจอีกครั้งใน transaction Purpose ที่บันทึกคือ Routine, QC, Calibration, Verification/Validation, Repeat/Troubleshooting, Waste หรือ Other การย้าย stock ใช้ movement ลบ/บวกคู่กันภายใน warehouse เดียว Adjustment ต้องมีเหตุผลและ Supervisor/Admin; reversal ผูก source transaction ได้ครั้งเดียว สร้าง movement เครื่องหมายตรงข้ามและต้องไม่ทำให้ยอดติดลบ การตรวจนับ snapshot ยอดตาม LOT/location, รับค่าจริง, แสดง variance แล้ว Supervisor/Admin อนุมัติให้สร้าง adjustment เป็นชุด หาก ledger เปลี่ยนหลัง snapshot ให้หยุด approval เพื่อทบทวนใหม่ Expired disposal เป็นชนิดธุรกรรมเฉพาะ เก็บ LOT, จำนวน, วันและเหตุผลการทำลาย

**Reorder, expiry และ vendor.** Manual ROP เป็นค่า pack ที่กำหนด; Automatic ROP = average daily net issue ใน 90 วัน × lead time + safety stock โดยนับ Routine/QC/Calibration/Verification/Repeat/Other ที่เป็นการใช้จริงและหัก reversal ของ issue ออก ไม่รวม transfer, generic adjustment, Waste และ expired disposal หาก lead time, safety stock หรือ history ที่จำเป็นไม่มี ให้แสดง `ต้องตั้งค่า` แทนเลข 0 Suggested order ใช้ target coverage days ลบยอด LOT ที่ยังไม่หมดอายุ และปัดขึ้นเป็นจำนวน pack ที่สั่งได้; รุ่นแรก **ไม่หัก open incoming orders** เพราะยังไม่มี PO lifecycle สำหรับคำนวณนั้น Expiry แยก expired, ≤30, 31–60, 61–90, >90 วันตามวันที่ Asia/Bangkok และแสดงระดับ LOT/location

Vendor Master, receipt assessment, issues, performance และ annual evaluation ใช้หลักฐานรับเข้าและช่วงปีงบประมาณ **1 ต.ค.–30 ก.ย.** Evaluation เก็บ snapshot ของ metrics พร้อม evaluator/reviewer/approver; ผลคะแนนและคำตัดสินเชิงเกณฑ์คงว่างจนมี scoring policy ที่อนุมัติ ไม่สร้าง threshold เอง Attention center รวบรวม stock หมด, ต่ำกว่า ROP, expiry และ discrepancy/vendor issue โดยไม่รบกวนด้วย modal ซ้ำ

**หน้าจอและ PWA.** Dashboard มี switch `CLINICAL CHEMISTRY | IMMUNOLOGY` ที่เห็นเด่นชัด การเปลี่ยนต้องเปลี่ยน KPI, attention, consumption, reorder, LOT expiry, movements และ vendor metrics ทุกส่วนพร้อมกัน Inventory list ค้น Product Code/REF/barcode/name และกรอง warehouse, type, platform, low/out-of-stock; Product detail แสดง identity, related products, LOT, reorder และ provenance หน้า mobile ใช้การ์ด/สรุปก่อนรายละเอียด ไม่บีบตาราง desktop; navigation หลัก Home, Stock, Scan, Receive, More และ touch targets อย่างน้อยประมาณ 44 px รายงานรายเดือน reconcile opening + received − issued ± adjustments − disposal ± reversals = closing พร้อม expiry/reorder/vendor ใช้หน้า HTML print และ browser Print-to-PDF ที่ตรวจฟอนต์ไทย

Phase 3 เพิ่ม manifest, favicon, Apple Touch Icon และ maskable icons จากงานศิลป์ที่อนุมัติ ทดสอบ Chrome install กับ iPhone Add to Home Screen งานไอคอนไม่เป็น dependency ของ Product Master หรือ inventory core [แนวทาง PWA ของ Next.js](https://nextjs.org/docs/app/guides/progressive-web-apps)

## 4. โครงสร้างฐานข้อมูล, API, security และ import

ใช้ตารางใหม่ prefix `ci_*` ในโปรเจกต์ Supabase เป้าหมาย แบ่งเป็นกลุ่ม:

- **Identity/master:** `ci_warehouses`, `ci_user_access`, `ci_product_code_counters`, `ci_products`, `ci_product_identifiers`, `ci_product_relations`, `ci_platforms`, `ci_product_platforms`, `ci_locations`, `ci_vendors`
- **Receiving/stock:** `ci_invoices`, `ci_invoice_lines`, `ci_receipts`, `ci_receipt_lines`, `ci_receipt_assessments`, `ci_stock_lots`, `ci_stock_transactions`, `ci_stock_movement_lines`, `ci_stock_counts`, `ci_stock_count_lines`
- **Control/evidence:** `ci_reorder_settings`, `ci_vendor_issues`, `ci_vendor_evaluations`, `ci_vendor_evaluation_approvals`, `ci_attachments`, `ci_import_batches`, `ci_import_rows`, `ci_import_review_items`, `ci_audit_logs` ส่วน attention คำนวณจากข้อมูลจริงและเก็บเฉพาะสถานะ acknowledgment ที่จำเป็น

ข้อบังคับหลักคือ composite warehouse FKs, Product Code/REF_CURRENT/barcode ที่ resolve ได้แบบ unique, positive quantity, LOT uniqueness ต่อ Product พร้อม hold เมื่อ expiry ขัดกัน, relation target-type trigger, immutable Product Code และ confirmed ledger, unique reversal source และ idempotency key ไม่ใช้ `No.` เป็น key เลขและ identifier เก็บเป็น `text`; จำนวน stock ใช้หน่วย pack เป็นฐานเริ่มต้นและไม่แปลง `Packing Size` ที่เป็นข้อความเป็นปริมาณโดยเดา

Next.js server actions/route handlers รับคำขอ ตรวจ session กับ Supabase Auth และส่ง mutation ผ่านฟังก์ชัน transaction ที่กำหนดชัดเจน: `create_product`, `apply_import_batch`, `save_product_relation`, `confirm_receipt`, `issue_stock`, `transfer_stock`, `adjust_stock`, `reverse_transaction`, `approve_stock_count`, `dispose_expired_stock`, `approve_identifier_mapping` ทุกฟังก์ชันตรวจ actor/role/warehouse, payload, idempotency และ constraint ในฐานข้อมูลด้วย ไม่รับ actor ID ที่ client อ้างเอง ฟังก์ชัน privileged อยู่ใน schema ที่ไม่ expose; grants จำกัดตามหน้าที่, `search_path` ปักแน่น และไม่มี service-role key ใน browser ตารางที่ expose เปิด RLS พร้อม policy ตาม role **และ warehouse**; invoice photo/vendor evidence อยู่ private Storage พร้อม policy และ signed access ที่จำกัด [แนวทาง RLS ของ Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)

Audit เก็บ before/after ที่จำเป็นสำหรับ master/identifier/relationship, actor และเหตุผลของ operation, approval, reversal และการเปลี่ยนสิทธิ์ โดยไม่ใช้ audit แทน ledger Product relationship ลบจาก current-state table ได้ แต่ audit ยังเก็บเหตุการณ์ Confirmed receipt/stock history ไม่ถูกลบ

**Import hard gate:** parse workbook → เก็บ raw row/checksum → normalize เฉพาะรูปแบบที่ระบุชัด → ตรวจ count/duplicate/missing/type/warehouse/legacy/relationship/platform → สร้าง review queue → dry run และ preview → ผู้รับผิดชอบอนุมัติ mapping/packing ที่ค้าง → apply แบบ transaction เดียว → reconcile จำนวนและ code sequence ข้อความที่ไม่ตรงไม่ auto-link; สามารถนำ Product เข้าชุด staging เพื่อ review ได้ แต่ห้ามเปิดใช้ Product Master ใน Production ก่อนตัดสินรายการ critical ทุกแถว รายงาน import ต้องแสดง 162/90/72, ชนิดสินค้า, 29 legacy aliases, 90 confirmed Product links, 27 platform source links, 12 review rows และข้อผิดปกติ packing/numbering ตามผลตรวจด้านบน

Schema ใช้ versioned migrations ที่ผ่าน disposable local PostgreSQL และ Preview ก่อน Production; initial data import เป็น batch แยกจาก schema migration ไม่แตะ Stock-BM และไม่ใช้ Excel เก่า การย้อนแอปใช้ Vercel deployment ก่อนหน้า; การแก้ schema หลังเปิดใช้เป็น forward corrective migration; การแก้ stock หลัง confirm ใช้ reversal/adjustment พร้อม audit และ backup/reconciliation ก่อน cutover

## 5. การพัฒนา การทดสอบ และเกณฑ์เปิดใช้

| Phase | งานและผลลัพธ์ | Gate |
|---|---|---|
| **1 — Foundation + complete inventory core** | ตั้ง Next.js/Auth/role/warehouse; master, identifiers, relationships, platform mapping, import review; locations/LOT/ledger; manual invoice, partial receiving, issue/FEFO, transfer, adjustment, reversal, count, disposal, audit | Product Master validation และ mapping ที่ critical ได้รับอนุมัติ; real PostgreSQL tests พิสูจน์ warehouse isolation, atomicity และ concurrency |
| **2 — Intelligent receiving + control** | iPhone scanner, GS1/HIBC, unknown barcode review, invoice photo, receipt assessment, vendor lifecycle/evaluation, reorder, expiry และ attention center | สแกน/รับเข้าบน iPhone จริง; identifier conflict ไม่ auto-link; vendor score ว่างเมื่อ policy ยังไม่อนุมัติ |
| **3 — Dashboard + reports + PWA + production hardening** | warehouse dashboard, inventory UX polish, monthly print/PDF, manifest/icons, performance/accessibility, security audit, backup/cutover/monitoring | รายงาน reconcile กับ ledger, Chrome/iPhone install ผ่าน, end-to-end acceptance และ production smoke ผ่าน |

แต่ละ phase ต้องส่ง migration/API/UI พร้อม focused tests และหลักฐาน gate ของ phase นั้น ไม่แยกเป็น phase ย่อยจำนวนมาก

**ชุดทดสอบที่ต้องมี:** import fixture ของ workbook hash นี้, 162/90/72 และชนิด, REF/leading zero/barcode/legacy, 90/27/12 classification และห้าม fuzzy link; relation type/self/cross-warehouse/add/edit/hard-delete; GS1-128/DataMatrix/HIBC/AI 240/LOT/expiry/serial/malformed/conflicting identifier; receiving แบบ partial/mixed warehouse, FEFO override, insufficient stock, transfer, adjustment/reversal/count/disposal; ROP 90 วัน, reversal และการตัด transfer/adjustment ออก; RLS/role escalation/storage; report reconciliation; responsive 375/768 px, repeated scan และ iPhone camera ต้องมี **สอง PostgreSQL sessions ที่ interleave จริง** สำหรับ simultaneous issue, receive, code allocation และ double submit ไม่ใช้ source-text assertions แทน DB concurrency test

**Production verification:** หลังได้รับอนุมัติแยกสำหรับ rollout ให้ตรวจ Ephis login → เลือกคลัง → invoice เดียวที่มีสองคลัง → ถ่ายรูป → สแกน/resolve → LOT/expiry → confirm receipt → ยอดเพิ่ม → FEFO issue → ยอดลด → reorder/expiry attention → count/adjustment/reversal → audit → รายงานรายเดือน reconcile ทุกขั้นตอนต้องทำได้โดยไม่แก้ DB ด้วยมือ สำรองข้อมูลก่อน cutover, ตรวจ Preview และสิทธิ์จริง, ติดตาม error/latency/failed RPC และเตรียม rollback deployment แนะนำติดตั้ง Vercel CLI ด้วย `npm i -g vercel` เพื่อใช้ `vercel env pull`, `vercel deploy` และ `vercel logs` ในขั้น Preview/ตรวจปัญหา

**การตัดสินที่ต้องได้รับจากเจ้าของข้อมูลก่อน gate ที่เกี่ยวข้อง:** ยืนยัน 12 `Used with` ใน review queue ว่าจะผูกเป้าหมายใดหรือคงไม่ผูก; เติม/รับรอง packing size 3 ค่าและข้อความ HCV ที่ดูถูกตัด; ตัดสินความหมายของ `Reaction Cell c503/c513` เทียบกับ platform group และชนิดของรายการที่มีชื่อ `STANDARD`; ยืนยันวิธี provision Ephis ID กับ Supabase Auth; ระบุผู้อนุมัติ import และนโยบาย vendor scoring/approval หากต้องการผลประเมินเชิงคะแนน สิ่งเหล่านี้เป็น **hold** ที่ระบุชัด ไม่ใช่สิทธิ์ให้ผู้พัฒนาคาดเดา

**Definition of Done:** 162 สินค้าและความสัมพันธ์ที่อนุมัติ reconcile กับ workbook ใหม่โดยไม่มี mapping เงียบ; code ไม่ซ้ำ/ไม่ใช้ซ้ำ; สองคลังแยกจริง; ledger append-only และไม่ติดลบภายใต้ concurrent requests; workflow รับเข้า→เบิก→รายงานครบ; role/RLS/storage ผ่าน; mobile iPhone ใช้งานจริง; vendor evidence และรายงานถูกต้อง; Chrome/iPhone ติดตั้งได้; production verification และแผน rollback มีหลักฐานก่อนประกาศพร้อมใช้
