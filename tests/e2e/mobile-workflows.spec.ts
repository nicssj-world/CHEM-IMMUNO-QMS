import { expect, test } from '@playwright/test';
import axe from 'axe-core';
import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('local authenticated inventory flows, responsive surfaces, CSP, photo evidence and mappings', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  const duplicateAuthClientWarnings: string[] = [];
  const serverErrors: string[] = [];
  const baseUrl = process.env.CI_E2E_BASE_URL ?? 'http://localhost:3100';
  const origin = new URL(baseUrl).origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.text().includes('Multiple GoTrueClient instances detected')) duplicateAuthClientWarnings.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 500 && response.url().startsWith(origin)) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    const target = window as Window & { __cspViolations?: string[] };
    target.__cspViolations = [];
    window.addEventListener('securitypolicyviolation', event => target.__cspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password = process.env.CI_E2E_PASSWORD!;
  if (!url || !publishable || !service || !password || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) throw new Error('Disposable local Supabase required');
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = await admin.storage.getBucket('ci-invoice-evidence');
  if (!bucket.data) {
    const createdBucket = await admin.storage.createBucket('ci-invoice-evidence', {
      public: false,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'],
    });
    expect(createdBucket.error).toBeNull();
  }
  const email = 'ephis.e2eadmin@chem-immuno.internal';
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(user.error).toBeNull();
  const bootstrap = await admin.rpc('ci_bootstrap_first_admin', { p_ephis_id: 'e2eadmin', p_display_name: 'Synthetic E2E Admin' });
  expect(bootstrap.error).toBeNull();
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
  for (const identity of [
    { ephis: 'e2estaff', role: 'staff', warehouseIds: [1] },
    { ephis: 'e2esupervisor', role: 'supervisor', warehouseIds: [2] },
    { ephis: 'e2eviewer', role: 'viewer', warehouseIds: [1] },
  ] as const) {
    const roleUser = await admin.auth.admin.createUser({ email: `ephis.${identity.ephis}@chem-immuno.internal`, password, email_confirm: true });
    expect(roleUser.error).toBeNull();
    const provisioned = await client.rpc('ci_provision_user', {
      p_ephis_id: identity.ephis,
      p_display_name: `Synthetic ${identity.role}`,
      p_role: identity.role,
      p_warehouse_ids: identity.warehouseIds,
      p_active: true,
    });
    expect(provisioned.error).toBeNull();
  }

  let chemProduct = '';
  let chemReagent2 = '';
  let chemCalibrator = '';
  for (const [warehouse_id, product_type, source_name, current_ref, manufacturer_barcode] of [
    [1, 'reagent', 'Synthetic CHE one', 'E2E-C1', 'E2E-B1'],
    [1, 'reagent', 'Synthetic CHE two', 'E2E-C2', 'E2E-B2'],
    [1, 'calibrator', 'Synthetic CHE calibrator', 'E2E-CAL', 'E2E-BCAL'],
    [2, 'reagent', 'Synthetic IMM', 'E2E-I1', 'E2E-IB1'],
  ] as const) {
    const created = await client.rpc('ci_create_product', { p_data: { warehouse_id, product_type, source_name, current_ref, manufacturer_barcode } });
    expect(created.error).toBeNull();
    if (current_ref === 'E2E-C1') chemProduct = created.data as string;
    if (current_ref === 'E2E-C2') chemReagent2 = created.data as string;
    if (current_ref === 'E2E-CAL') chemCalibrator = created.data as string;
  }
  expect((await admin.from('ci_product_identifiers').insert({ product_id: chemProduct, warehouse_id: 1, kind: 'GTIN', value: '00012345678905', source: 'synthetic_e2e' })).error).toBeNull();
  const vendor = await client.rpc('ci_create_vendor', { p_data: { vendorCode: 'V-E2E', name: 'Synthetic E2E Vendor' } });
  expect(vendor.error).toBeNull();
  const location = await client.rpc('ci_create_location', { p_warehouse_id: 1, p_code: 'E2E-A', p_name: 'Synthetic shelf' });
  expect(location.error).toBeNull();
  const invoice = await client.rpc('ci_create_invoice', { p_data: { vendor_id: vendor.data, invoice_number: 'E2E-INV-1', invoice_date: '2026-09-24', lines: [{ product_id: chemProduct, quantity: 10 }] } });
  expect(invoice.error).toBeNull();
  const invoiceLine = await admin.from('ci_invoice_lines').select('id').eq('invoice_id', invoice.data).single();
  expect(invoiceLine.error).toBeNull();

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  const loginHeaders = await page.locator('body').evaluate(node => (node as HTMLElement).innerText);
  expect(loginHeaders).toContain('Ephis ID');
  const response = await page.request.get(`${origin}/login`);
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  if (csp.includes("'unsafe-eval'")) {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src[^;]*nonce-/);
  } else {
    expect(csp).toContain("style-src 'self' 'nonce-");
  }
  expect(await page.locator('script[nonce]').count()).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2eadmin');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^สินค้าที่ใช้งาน 3/ })).toBeVisible();
  const dashboardMetricLabels = [
    'สินค้าที่ใช้งาน', 'หมดสต็อก', 'ต่ำกว่า ROP', 'LOT หมดอายุแล้ว', 'หมดอายุใน 30 วัน', 'หมดอายุใน 90 วัน',
    'ยังไม่ตั้ง ROP', 'LOT ทั้งหมด', 'รับเข้า 7 วัน', 'เบิกใช้ 7 วัน',
  ];
  async function expectDashboardMetrics() {
    for (const label of dashboardMetricLabels) {
      const count = page.getByText(label, { exact: true }).locator('..').locator('strong');
      await expect(count, `dashboard metric ${label}`).toHaveText(/^\d+$/);
    }
  }
  await expectDashboardMetrics();
  await page.getByRole('navigation', { name: 'เลือกคลัง' }).getByRole('link', { name: 'IMMUNOLOGY' }).click();
  await expect(page).toHaveURL(/warehouse=IMM/);
  await expect(page.getByRole('link', { name: /^สินค้าที่ใช้งาน 1/ })).toBeVisible();
  await expectDashboardMetrics();

  await page.goto('/products/new?warehouse=CHE');
  await page.getByLabel('ชื่อสินค้าตามแหล่งข้อมูล').fill('Synthetic UI product source');
  await page.getByLabel('ชื่อที่แสดง').fill('Synthetic UI product');
  await page.getByLabel('ประเภท').selectOption('control');
  await page.getByLabel('ขนาดบรรจุ (ข้อความต้นฉบับ)').fill('2 x 10 mL');
  await page.getByLabel('REF ปัจจุบัน').fill('E2E-UI-REF');
  await page.getByLabel('Manufacturer barcode').fill('E2E-UI-BARCODE');
  await page.getByRole('button', { name: 'สร้างสินค้า' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic UI product' })).toBeVisible();
  const uiProductId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByLabel('ชื่อที่แสดง').fill('Synthetic UI product edited');
  await page.getByLabel('ประเภท').selectOption('reagent');
  await page.getByLabel('ขนาดบรรจุ').fill('3 x 20 mL');
  await page.getByRole('button', { name: 'บันทึกข้อมูลสินค้า' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic UI product edited' })).toBeVisible();
  const uiProduct = await admin.from('ci_products')
    .select('source_name,display_name,product_type,packing_size_raw')
    .eq('id', uiProductId)
    .single();
  expect(uiProduct.error).toBeNull();
  expect(uiProduct.data).toMatchObject({
    source_name: 'Synthetic UI product source',
    display_name: 'Synthetic UI product edited',
    product_type: 'reagent',
    packing_size_raw: '3 x 20 mL',
  });
  const uiIdentifiers = await admin.from('ci_product_identifiers')
    .select('kind,value')
    .eq('product_id', uiProductId)
    .order('kind');
  expect(uiIdentifiers.error).toBeNull();
  expect(uiIdentifiers.data).toEqual([
    { kind: 'MANUFACTURER_BARCODE', value: 'E2E-UI-BARCODE' },
    { kind: 'REF_CURRENT', value: 'E2E-UI-REF' },
  ]);

  for (const term of ['E2E-C1', 'E2E-B1', 'Synthetic CHE one']) {
    await page.goto(`/products?warehouse=CHE&q=${encodeURIComponent(term)}`);
    await expect(page.getByRole('link', { name: 'CHE-0001', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CHE-0002', exact: true })).toHaveCount(0);
  }
  await page.goto('/products?warehouse=CHE&type=calibrator');
  await expect(page.getByRole('link', { name: 'CHE-0003', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CHE-0001', exact: true })).toHaveCount(0);

  await page.goto('/vendors?warehouse=CHE');
  await expect(page.getByRole('heading', { name: 'ผู้ขาย', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Synthetic E2E Vendor/ }).first().click();
  await expect(page.getByRole('heading', { name: /ผลงานผู้ขาย · .* · ปีงบประมาณ 25\d\d/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /รายงานประเมินประจำปี/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /ผลตรวจรับรายครั้ง/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /ปัญหาผู้ขาย/ })).toBeVisible();
  await expect(page.getByText('ผลตามเกณฑ์ 8 ข้อ (ข้อมูลสด)')).toBeVisible();
  await expect(page.getByText(/ยังไม่ใช่คะแนนอย่างเป็นทางการ/)).toBeVisible();
  await page.goto('/vendors/evaluation-policy');
  await expect(page.getByRole('heading', { name: /นโยบาย/ }).first()).toBeVisible();

  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  const keyboardFocus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const outline = getComputedStyle(active);
    return { tag: active.tagName, outlineStyle: outline.outlineStyle, outlineWidth: outline.outlineWidth };
  });
  expect(keyboardFocus?.tag).not.toBe('BODY');
  expect(keyboardFocus?.outlineStyle).not.toBe('none');
  expect(Number.parseFloat(keyboardFocus?.outlineWidth ?? '0')).toBeGreaterThan(0);

  const routes = [
    '/login', '/', '/stock?warehouse=CHE', '/products?warehouse=CHE', `/products/${chemProduct}`,
    '/scan?warehouse=CHE', '/receive?warehouse=CHE', '/attention?warehouse=CHE', '/reorder?warehouse=CHE',
    '/reports/monthly?warehouse=CHE&month=2026-09', '/more', '/vendors?warehouse=CHE',
    '/admin/users', '/scan/review?warehouse=CHE', '/audit?warehouse=CHE',
  ];
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      const routeResponse = await page.goto(route);
      expect(routeResponse?.status(), route).toBeLessThan(400);
      await expect(page.locator('main'), `main landmark visible at ${route}`).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(2);
      const unlabeled = await page.locator('input:not([type="hidden"]), select, textarea').evaluateAll(elements => elements
        .filter(element => {
          const control = element as HTMLInputElement;
          return control.type !== 'submit' && !control.labels?.length && !control.getAttribute('aria-label');
        }).map(element => (element as HTMLElement).outerHTML.slice(0, 120)));
      expect(unlabeled, `${route} has unlabeled controls`).toEqual([]);
      const unnamed = await page.locator('button').evaluateAll(elements => elements
        .filter(element => {
          const button = element as HTMLElement;
          const box = button.getBoundingClientRect();
          return !button.closest('details:not([open])') && box.width > 0 && box.height > 0 && !button.innerText.trim() && !button.getAttribute('aria-label') && !button.querySelector('[aria-label],title');
        })
        .map(element => (element as HTMLElement).outerHTML.slice(0, 120)));
      expect(unnamed, `${route} has unnamed buttons`).toEqual([]);
      const smallTargets = await page.locator('.button, .input, .bottom-nav a').evaluateAll(elements => elements
        .map(element => Math.round((element as HTMLElement).getBoundingClientRect().height)).filter(height => height > 0 && height < 44));
      expect(smallTargets, `${route} has undersized touch targets`).toEqual([]);
      if (width === 375 && ['/', '/receive?warehouse=CHE', '/reports/monthly?warehouse=CHE&month=2026-09'].includes(route)) {
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => {
          type AxeApi = {
            run: (context: Document, options: { runOnly: { type: 'tag'; values: string[] } }) => Promise<{
              violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }>;
            }>;
          };
          const axeApi = (window as Window & { axe?: AxeApi }).axe;
          if (!axeApi) throw new Error('axe-core did not load in the browser');
          const results = await axeApi.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
          });
          return results.violations.map(({ id, impact, help, nodes }) => ({ id, impact, help, targets: nodes.map(node => node.target) }));
        });
        expect(violations, `${route} accessibility violations`).toEqual([]);
      }
      if (width === 375 && ['/', '/receive?warehouse=CHE', '/reports/monthly?warehouse=CHE&month=2026-09'].includes(route)) {
        const label = route === '/' ? 'dashboard' : route.startsWith('/receive') ? 'receive' : 'report';
        await page.screenshot({ path: testInfo.outputPath(`${label}-375.png`), fullPage: true });
      }
    }
  }

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'เมนูมือถือ' }).getByRole('link', { name: 'สแกน' }).click();
  await expect(page).toHaveURL(/\/scan$/);
  await page.goto('/scan');
  await expect(page.getByRole('button', { name: /สแกนอีกครั้ง/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ })).toBeVisible();
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText('CHE-0001')).toBeVisible();
  await expect(page.getByText(/^LOT LOT-A/)).toBeVisible();

  await page.goto(`/receive?invoice=${invoice.data}`);
  await expect(page.getByRole('heading', { name: 'ตรวจและรับสินค้า' })).toBeVisible();
  const cameraInput = page.getByLabel('ถ่ายภาพด้วยกล้อง');
  expect(await cameraInput.getAttribute('capture')).toBe('environment');
  expect(await cameraInput.getAttribute('accept')).toBe('image/*');
  const evidence = await readFile(path.join(process.cwd(), 'public/icon-192.png'));
  await page.getByLabel('เลือกจากรูปภาพ/ไฟล์').setInputFiles({ name: 'invoice-evidence.png', mimeType: 'image/png', buffer: evidence });
  await expect(page.getByRole('img', { name: 'ตัวอย่างเอกสารก่อนอัปโหลด' })).toBeVisible();
  await page.getByRole('button', { name: 'บันทึกภาพ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'อัปโหลดภาพเอกสารส่วนตัวสำเร็จ' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /ดูเอกสาร/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกภาพ' })).toBeDisabled();
  await page.getByRole('button', { name: 'ลบก่อนยืนยัน' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'นำภาพออกแล้ว' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /ดูเอกสาร/ })).toHaveCount(0);
  await page.getByLabel('เลือกจากรูปภาพ/ไฟล์').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: evidence });
  await page.getByRole('button', { name: 'บันทึกภาพ' }).click();
  await expect(page.getByRole('link', { name: /ดูเอกสาร/ })).toBeVisible();
  await page.getByRole('button', { name: 'ลบก่อนยืนยัน' }).click();
  await expect(page.getByRole('link', { name: /ดูเอกสาร/ })).toHaveCount(0);

  const scanInput = page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ });
  await scanInput.fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByLabel(/LOT \(จาก Barcode/)).toHaveValue('LOT-A');
  await expect(page.getByLabel(/หมดอายุ \(จาก Barcode/)).toHaveValue('2027-01-01');
  await page.getByRole('combobox', { name: 'ตำแหน่ง', exact: true }).first().selectOption(location.data as string);
  await page.getByRole('button', { name: 'เพิ่มแพ็กเกจในร่าง' }).click();
  await expect(page.getByText(/เพิ่มแพ็กเกจในร่างแล้ว/)).toBeVisible();
  await expect(page.getByRole('button', { name: /สแกนอีกครั้ง/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /ยืนยันรับเข้า 1 แพ็กเกจ/ })).toBeVisible();
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'สแกนซ้ำเร็วเกินไป' })).toBeVisible();
  await page.waitForTimeout(2_600);
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByLabel(/LOT \(จาก Barcode/)).toHaveValue('LOT-A');
  await page.getByRole('combobox', { name: 'ตำแหน่ง', exact: true }).first().selectOption(location.data as string);
  await page.getByRole('button', { name: 'เพิ่มแพ็กเกจในร่าง' }).click();
  await expect(page.getByRole('button', { name: /ยืนยันรับเข้า 2 แพ็กเกจ/ })).toBeVisible();

  async function proposeUnknown(value: string) {
    await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill(`(240)${value}`);
    await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
    await expect(page.locator('code').filter({ hasText: `(240)${value}` })).toBeVisible();
    await expect(page.getByText(/ไม่พบสินค้า/).first()).toBeVisible();
    await page.getByLabel('Product ใน Invoice').selectOption(invoiceLine.data!.id);
    await page.getByRole('button', { name: 'เสนอการจับคู่ Barcode กับ Product ที่เลือก' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'ส่งข้อเสนอแล้ว' })).toBeVisible();
  }
  await proposeUnknown('E2E-MAP-APPROVE');
  const pendingApproval = await admin.from('ci_identifier_mapping_requests').select('id,status').eq('identifier_value', 'E2E-MAP-APPROVE').single();
  expect(pendingApproval.error).toBeNull();
  expect(pendingApproval.data?.status).toBe('proposed');
  await proposeUnknown('E2E-MAP-REJECT');
  await page.goto('/scan?warehouse=CHE');
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(240)E2E-MAP-APPROVE');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText(/ไม่พบสินค้า/).first()).toBeVisible();
  await page.goto('/scan/review?warehouse=CHE');
  const approvalCard = page.locator('article').filter({ hasText: 'E2E-MAP-APPROVE' });
  await approvalCard.getByLabel('เหตุผล / บันทึกการตัดสิน').fill('Synthetic approval acceptance');
  await approvalCard.getByRole('button', { name: 'อนุมัติ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'บันทึกผลแล้ว' })).toBeVisible();
  const rejectionCard = page.locator('article').filter({ hasText: 'E2E-MAP-REJECT' });
  await rejectionCard.getByLabel('เหตุผล / บันทึกการตัดสิน').fill('Synthetic rejection acceptance');
  await rejectionCard.getByRole('button', { name: 'ปฏิเสธ' }).click();
  await expect(rejectionCard).toHaveCount(0);
  const approved = await admin.from('ci_identifier_mapping_requests').select('status').eq('identifier_value', 'E2E-MAP-APPROVE').single();
  const rejected = await admin.from('ci_identifier_mapping_requests').select('status').eq('identifier_value', 'E2E-MAP-REJECT').single();
  expect(approved.data?.status).toBe('approved');
  expect(rejected.data?.status).toBe('rejected');
  await page.goto('/scan?warehouse=CHE');
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(240)E2E-MAP-APPROVE');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText('CHE-0001')).toBeVisible();
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill('(240)E2E-MAP-REJECT');
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText(/ไม่พบสินค้า/).first()).toBeVisible();

  await page.goto(`/products/${chemProduct}`);
  await expect(page.getByRole('heading', { name: 'Synthetic CHE one' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Identifiers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Related Products' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Platforms / Analyzer' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stock / LOT' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ROP / Suggested Order' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Provenance' })).toBeVisible();
  await expect(page.getByText('E2E-C1', { exact: true })).toBeVisible();
  const addRelation = page.getByRole('combobox', { name: 'ความสัมพันธ์จากสินค้านี้' }).first();
  await addRelation.selectOption('uses_calibrator');
  const targetSearch = page.getByLabel('ค้นหาเป้าหมาย').first();
  await targetSearch.fill('Synthetic CHE calibrator');
  const target = page.getByLabel('สินค้าเป้าหมาย').first();
  await expect(target.getByRole('option', { name: /CHE-0003/ })).toHaveCount(1);
  await expect(target.getByRole('option', { name: /CHE-0002/ })).toHaveCount(0);
  await target.selectOption(chemCalibrator);
  await page.getByRole('button', { name: 'เพิ่มความสัมพันธ์' }).click();
  await expect(page.locator('section.surface').filter({ hasText: 'Related Products' }).locator('span.badge').filter({ hasText: 'ใช้ Calibrator' })).toBeVisible();
  const relationRow = await admin.from('ci_product_relations').select('id').eq('source_product_id', chemProduct).eq('target_product_id', chemCalibrator).single();
  expect(relationRow.error).toBeNull();
  await page.getByText('แก้ไข', { exact: true }).first().click();
  const editRelation = page.getByRole('combobox', { name: 'ความสัมพันธ์จากสินค้านี้' }).first();
  await editRelation.selectOption('compatible_with');
  const editSearch = page.getByLabel('ค้นหาเป้าหมาย').first();
  await editSearch.fill('Synthetic CHE two');
  const editTarget = page.getByLabel('สินค้าเป้าหมาย').first();
  await expect(editTarget.getByRole('option', { name: /CHE-0002/ })).toHaveCount(1);
  await editTarget.selectOption(chemReagent2);
  await page.getByRole('button', { name: 'บันทึกความสัมพันธ์' }).click();
  await expect(page.locator('section.surface').filter({ hasText: 'Related Products' }).locator('span.badge').filter({ hasText: 'ใช้ร่วมกันได้' })).toBeVisible();
  const updatedRelation = await admin.from('ci_product_relations').select('id,relation_type,target_product_id').eq('id', relationRow.data!.id).single();
  expect(updatedRelation.data?.relation_type).toBe('compatible_with');
  expect(updatedRelation.data?.target_product_id).toBe(chemReagent2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ลบความสัมพันธ์' }).click();
  await expect(page.getByText('ยังไม่มีความสัมพันธ์ที่ยืนยันแล้ว')).toBeVisible();
  const deleteAudit = await admin.from('ci_audit_logs').select('id', { count: 'exact', head: true }).eq('entity_table', 'ci_product_relations').eq('entity_id', relationRow.data!.id).eq('action', 'DELETE');
  expect(deleteAudit.error).toBeNull();
  expect(deleteAudit.count).toBe(1);

  // Leave the receipt draft unconfirmed; no stock movements are created by browser acceptance.
  const movementCount = await admin.from('ci_stock_transactions').select('id', { count: 'exact', head: true });
  expect(movementCount.error).toBeNull();
  expect(movementCount.count).toBe(0);
  await page.getByRole('navigation', { name: 'เมนูมือถือ' }).getByRole('link', { name: 'เพิ่มเติม' }).click();
  await expect(page).toHaveURL(/\/more$/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/reports/monthly?warehouse=CHE&month=2026-09');
  const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
  expect(pdf.length).toBeGreaterThan(1000);
  const pdfPath = testInfo.outputPath('monthly-report.pdf');
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdf);
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).display).toBe('standalone');
  for (const icon of ['/favicon-64.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']) expect((await request.get(icon)).ok()).toBeTruthy();

  async function signInAs(ephisId: string) {
    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Ephis ID' }).fill(ephisId);
    await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  }
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2estaff');
  await page.goto('/products?warehouse=CHE');
  await expect(page.getByRole('link', { name: 'เพิ่มสินค้า' })).toHaveCount(0);
  await page.goto('/receive?warehouse=CHE');
  await expect(page.getByRole('heading', { name: 'สร้าง Invoice' })).toBeVisible();
  await page.goto('/scan/review?warehouse=CHE');
  await expect(page.getByRole('button', { name: 'อนุมัติ' })).toHaveCount(0);
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2esupervisor');
  await page.goto('/products?warehouse=IMM');
  await expect(page.getByRole('link', { name: 'เพิ่มสินค้า' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByText('หน้านี้ใช้ได้เฉพาะผู้ดูแลระบบที่มีสิทธิ์ทั้งสองคลัง')).toBeVisible();
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2eviewer');
  await page.goto('/products?warehouse=CHE');
  await expect(page.getByRole('link', { name: 'เพิ่มสินค้า' })).toHaveCount(0);
  await page.goto('/scan?warehouse=CHE');
  await expect(page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ })).toHaveCount(0);
  await page.goto('/receive?warehouse=CHE');
  await expect(page.getByRole('heading', { name: 'สร้าง Invoice' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([]);
  expect(duplicateAuthClientWarnings).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
