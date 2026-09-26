import { expect, test } from '@playwright/test';
import axe from 'axe-core';
import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('local authenticated inventory flows, responsive surfaces, CSP, photo evidence and mappings', async ({ page, request }, testInfo) => {
  test.setTimeout(420_000);
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
  // Phase 1 fixtures: a monitored refrigerator with a shelf (CHE), a monitored IMM refrigerator, and a Portal link. Locations are master data, not stock.
  const portalUrl = 'https://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000';
  const rangeEnv = { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };
  const fridge = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-FR', name: 'Synthetic fridge', location_type: 'refrigerator', room: 'Synthetic room', storage_condition: '2–8 °C', portal_equipment_url: portalUrl, portal_equipment_label: 'Synthetic fridge in Portal', env: rangeEnv } });
  expect(fridge.error).toBeNull();
  const fridgeShelf = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-FR-S1', name: 'Synthetic fridge shelf', location_type: 'shelf', parent_location_id: fridge.data } });
  expect(fridgeShelf.error).toBeNull();
  const immFridge = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 2, code: 'E2E-IMM-FR', name: 'Synthetic IMM fridge', location_type: 'refrigerator', env: rangeEnv } });
  expect(immFridge.error).toBeNull();
  const locationTokens = await admin.from('ci_locations').select('id,qr_token').in('id', [fridge.data as string, fridgeShelf.data as string, immFridge.data as string]);
  expect(locationTokens.error).toBeNull();
  const tokenOf = (id: string) => locationTokens.data!.find(row => row.id === id)!.qr_token as string;
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
    '/locations?warehouse=CHE', '/locations/new?warehouse=CHE', `/locations/${fridge.data}`, `/locations/${fridgeShelf.data}`, `/locations/${fridge.data}/edit`, '/locations/qr?warehouse=CHE',
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
      if (width === 375 && ['/', '/receive?warehouse=CHE', '/reports/monthly?warehouse=CHE&month=2026-09', '/locations?warehouse=CHE', '/locations/new?warehouse=CHE', `/locations/${fridge.data}`].includes(route)) {
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

  async function expectNotFound(url: string, why: string) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'ไม่พบข้อมูลที่ต้องการ' }), why).toBeVisible();
    await expect(page.getByRole('heading', { name: /E2E-/ }), `${why}: nothing about the location is shown`).toHaveCount(0);
  }
  // ---- Phase 1: workspace navigation ------------------------------------------------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'เมนูหลัก' });
  await expect(sidebar.getByRole('link'), 'compact sidebar: the Scan quick action plus five workspaces').toHaveCount(6);
  for (const name of ['สแกน Barcode', 'ภาพรวม', 'คลังสินค้า', 'ปฏิบัติงาน', 'รายงาน', 'จัดการระบบ']) await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByText(/Morning Talk|อุณหภูมิ ?\/ ?ความชื้น/), 'no placeholder links for later phases').toHaveCount(0);
  const dashboardTabs = page.getByRole('navigation', { name: 'เมนูย่อย ภาพรวม' });
  await expect(dashboardTabs.getByRole('link', { name: 'ภาพรวม', exact: true })).toHaveAttribute('aria-current', 'page');
  await sidebar.getByRole('link', { name: 'คลังสินค้า', exact: true }).click();
  await expect(page).toHaveURL(/\/stock$/);
  const inventoryTabs = page.getByRole('navigation', { name: 'เมนูย่อย คลังสินค้า' });
  await expect(inventoryTabs.getByRole('link')).toHaveCount(5);
  await expect(inventoryTabs.getByRole('link', { name: 'คงคลัง', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'คลังสินค้า', exact: true })).toHaveAttribute('aria-current', 'page');
  // Tabs carry the warehouse and nothing else; browser back/forward restore the previous tab and its state.
  await page.goto('/stock?warehouse=IMM&q=zzz');
  await inventoryTabs.getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true }).click();
  await expect(page).toHaveURL(/\/locations\?warehouse=IMM$/);
  await expect(inventoryTabs.getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/\/stock\?warehouse=IMM&q=zzz$/);
  await expect(inventoryTabs.getByRole('link', { name: 'คงคลัง', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page).toHaveURL(/\/locations\?warehouse=IMM$/);
  // Existing deep links keep working and land on the right workspace and tab.
  for (const [url, workspace, tab] of [
    ['/vendors/evaluation-policy', 'คลังสินค้า', 'ผู้ขาย'], [`/products/${chemProduct}`, 'คลังสินค้า', 'สินค้า'], ['/counts?warehouse=CHE', 'ปฏิบัติงาน', 'ตรวจนับ'],
    ['/adjust?warehouse=CHE', 'ปฏิบัติงาน', 'ปรับยอด'], ['/reports/monthly?warehouse=CHE&month=2026-09', 'รายงาน', 'รายงานรายเดือน'], ['/audit?warehouse=CHE', 'รายงาน', 'บันทึกการตรวจสอบ'],
    ['/scan/review?warehouse=CHE', 'จัดการระบบ', 'คิวอนุมัติ Barcode'], ['/admin/users', 'จัดการระบบ', 'ผู้ใช้'], ['/attention?warehouse=CHE', 'ภาพรวม', 'รายการที่ต้องติดตาม'],
  ] as const) {
    await page.goto(url);
    await expect(sidebar.getByRole('link', { name: workspace, exact: true }), `${url} sidebar`).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: `เมนูย่อย ${workspace}` }).getByRole('link', { name: tab, exact: true }), `${url} tab`).toHaveAttribute('aria-current', 'page');
  }
  await expect(sidebar.getByRole('link', { name: 'สแกน Barcode' }), '/scan/review is not the Scan quick action').not.toHaveAttribute('aria-current', 'page');
  await page.goto('/locations?warehouse=CHE');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'เมนูย่อย คลังสินค้า' })).toBeHidden();
  await expect(sidebar).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/locations?warehouse=CHE');
  const bottom = page.getByRole('navigation', { name: 'เมนูมือถือ' });
  await expect(bottom.getByRole('link'), 'the accepted mobile bottom navigation is unchanged').toHaveText(['ภาพรวม', 'คงคลัง', 'สแกน', 'รับเข้า', 'เพิ่มเติม']);
  await expect(bottom.getByRole('link', { name: 'คงคลัง' }), 'Stock also lights up for Inventory pages').toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'เมนูย่อย คลังสินค้า' }).getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true })).toBeVisible();
  await page.goto('/more');
  for (const heading of ['ภาพรวม', 'คลังสินค้า', 'ปฏิบัติงาน', 'รายงาน', 'จัดการระบบ']) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'คลังสินค้า', exact: true }).getByRole('link', { name: 'ตำแหน่งจัดเก็บ' })).toBeVisible();
  await expect(page.getByText(/Morning Talk|อุณหภูมิ ?\/ ?ความชื้น/)).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- Phase 1: Location Master through the UI ---------------------------------------------------------------------------
  await page.goto('/locations?warehouse=CHE');
  await expect(page.getByText('การแก้ไขหรือปิดใช้งานตำแหน่งยังไม่รองรับ')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /E2E-FR-S1/ }), 'a shelf reads as parent › code').toContainText('E2E-FR › E2E-FR-S1');
  await expect(page.getByRole('link', { name: /E2E-FR-S1/ })).toContainText('ตาม E2E-FR');
  await page.getByLabel('ค้นหาตำแหน่ง').fill('e2e-fr');
  await page.getByRole('button', { name: 'กรอง', exact: true }).click();
  await expect(page).toHaveURL(/q=e2e-fr/);
  await expect(page.getByRole('link', { name: /E2E-A/ })).toHaveCount(0);
  await page.goto('/locations?warehouse=CHE&type=shelf&active=1');
  await expect(page.getByRole('link', { name: /E2E-FR-S1/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^E2E-FR Synthetic fridge/ }), 'the type filter leaves out the refrigerator').toHaveCount(0);

  await page.goto('/locations/new?warehouse=CHE');
  await expect(page.getByLabel(/เวลาตรวจ|รอบตรวจ|ตารางตรวจ/), 'no check-time or schedule fields in Phase 1').toHaveCount(0);
  await page.getByLabel('รหัสตำแหน่ง').fill('E2E-UI-FZ');
  await page.getByLabel('ชื่อ / คำอธิบายสั้น').fill('Synthetic UI freezer');
  await page.getByLabel('ประเภท').selectOption('freezer');
  await page.getByLabel('ห้อง / พื้นที่').fill('Synthetic UI room');
  await page.getByLabel('เฝ้าระวังอุณหภูมิ (°C)').check();
  await page.getByLabel('อุณหภูมิ สูงสุด (°C)').fill('20');
  await page.getByRole('button', { name: 'สลับเครื่องหมายบวก/ลบ อุณหภูมิ สูงสุด' }).click();
  await expect(page.getByLabel('อุณหภูมิ สูงสุด (°C)')).toHaveValue('-20');
  await page.getByLabel('ลิงก์หน้าเครื่องมือใน Portal').fill('http://lab-management-cbh.vercel.app/staff/equipment/123e4567-e89b-42d3-a456-426614174000');
  await page.getByRole('button', { name: 'เพิ่มตำแหน่ง', exact: true }).click();
  await expect(page.getByText('ลิงก์ต้องขึ้นต้นด้วย https://'), 'an insecure Portal link is refused with a field message').toBeVisible();
  await expect(page.getByLabel('อุณหภูมิ สูงสุด (°C)'), 'the form keeps what was typed').toHaveValue('-20');
  await page.getByLabel('ลิงก์หน้าเครื่องมือใน Portal').fill(portalUrl);
  await page.getByLabel('ชื่อเครื่องมือที่แสดง').fill('Synthetic UI freezer in Portal');
  await page.getByRole('button', { name: 'เพิ่มตำแหน่ง', exact: true }).click();
  await expect(page.getByRole('heading', { name: /E2E-UI-FZ/ })).toBeVisible();
  await expect(page.getByText('≤ -20 °C')).toBeVisible();
  const portalAnchor = page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ });
  await expect(portalAnchor).toHaveAttribute('target', '_blank');
  await expect(portalAnchor).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(portalAnchor).toHaveAttribute('href', portalUrl);
  const uiFreezerId = new URL(page.url()).pathname.split('/').at(-1)!;
  const uiFreezer = await admin.from('ci_locations').select('code,location_type,room,portal_equipment_url,portal_equipment_label,updated_by').eq('id', uiFreezerId).single();
  expect(uiFreezer.data).toMatchObject({ code: 'E2E-UI-FZ', location_type: 'freezer', room: 'Synthetic UI room', portal_equipment_url: portalUrl, portal_equipment_label: 'Synthetic UI freezer in Portal' });
  const uiConfig = await admin.from('ci_location_env_configs').select('temperature_monitored,temp_min_c,temp_max_c,humidity_monitored').eq('location_id', uiFreezerId);
  expect(uiConfig.data).toEqual([{ temperature_monitored: true, temp_min_c: null, temp_max_c: -20, humidity_monitored: false }]);

  // A shelf placed in that freezer inherits its environment; the picker offers only top-level parents.
  await page.goto('/locations/new?warehouse=CHE');
  await page.getByLabel('รหัสตำแหน่ง').fill('E2E-UI-FZ-S1');
  await page.getByLabel('ชื่อ / คำอธิบายสั้น').fill('Synthetic UI freezer shelf');
  await page.getByLabel('ประเภท').selectOption('shelf');
  await expect(page.getByLabel('เฝ้าระวังอุณหภูมิ (°C)'), 'a shelf shows no monitoring fields until the override is ticked').toHaveCount(0);
  await expect(page.getByLabel('ตั้งค่าเฝ้าระวังแยกสำหรับตำแหน่งนี้')).toBeVisible();
  const parentSelect = page.getByLabel('วางอยู่ใน (ตำแหน่งแม่)');
  await expect(parentSelect.getByRole('option', { name: /E2E-FR-S1/ }), 'a shelf cannot be a parent').toHaveCount(0);
  await parentSelect.selectOption(uiFreezerId);
  await page.getByRole('button', { name: 'เพิ่มตำแหน่ง', exact: true }).click();
  await expect(page.getByRole('heading', { name: /E2E-UI-FZ › E2E-UI-FZ-S1/ })).toBeVisible();
  await expect(page.getByText(/สภาพแวดล้อมควบคุมโดย/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E-UI-FZ', exact: true }).first()).toBeVisible();
  await expect(page.getByText('≤ -20 °C')).toBeVisible();
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ }), "the parent's Portal link is offered on the shelf").toHaveAttribute('href', portalUrl);
  const uiShelfId = new URL(page.url()).pathname.split('/').at(-1)!;
  expect((await admin.from('ci_location_env_configs').select('id').eq('location_id', uiShelfId)).data).toEqual([]);
  expect((await admin.from('ci_locations').select('parent_location_id').eq('id', uiShelfId).single()).data?.parent_location_id).toBe(uiFreezerId);

  // Edit: optimistic locking, then a normal save.
  await page.goto(`/locations/${uiFreezerId}/edit?warehouse=CHE`);
  await page.getByLabel('ชื่อ / คำอธิบายสั้น').fill('Synthetic UI freezer (edited)');
  // Someone else saves first, so this form's version is stale.
  const openedAt = (await admin.from('ci_locations').select('updated_at').eq('id', uiFreezerId).single()).data!.updated_at;
  expect((await client.rpc('ci_update_location', { p_id: uiFreezerId, p: { description: 'changed elsewhere' }, p_expected_updated_at: openedAt })).error).toBeNull();
  await page.getByRole('button', { name: 'บันทึกการแก้ไข', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'มีผู้อื่นแก้ข้อมูลนี้ก่อนหน้า' }), 'an edit made from a stale form is refused').toBeVisible();
  expect((await admin.from('ci_locations').select('name').eq('id', uiFreezerId).single()).data?.name).toBe('Synthetic UI freezer');
  await page.goto(`/locations/${uiFreezerId}/edit?warehouse=CHE`);
  await page.getByLabel('ชื่อ / คำอธิบายสั้น').fill('Synthetic UI freezer (edited)');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข', exact: true }).click();
  await expect(page.getByText('Synthetic UI freezer (edited)').first()).toBeVisible();
  expect((await admin.from('ci_locations').select('name').eq('id', uiFreezerId).single()).data?.name).toBe('Synthetic UI freezer (edited)');

  // Deactivation: blocked while it has an active shelf, allowed once the shelf is closed; both are audited with a reason.
  await page.goto(`/locations/${uiFreezerId}?warehouse=CHE`);
  await page.getByLabel('เหตุผลที่ปิดการใช้งาน').fill('E2E retire freezer');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ปิดการใช้งาน', exact: true }).click();
  await expect(page.getByText(/ยังมีตำแหน่งย่อยที่ใช้งานอยู่/)).toBeVisible();
  await page.goto(`/locations/${uiShelfId}?warehouse=CHE`);
  await page.getByLabel('เหตุผลที่ปิดการใช้งาน').fill('E2E retire shelf');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ปิดการใช้งาน', exact: true }).click();
  await expect(page.getByText('ปิดการใช้งานตำแหน่งแล้ว')).toBeVisible();
  await expect(page.getByText(/ตำแหน่งนี้ปิดการใช้งานอยู่/)).toBeVisible();
  await page.goto(`/locations/${uiFreezerId}?warehouse=CHE`);
  await page.getByLabel('เหตุผลที่ปิดการใช้งาน').fill('E2E retire freezer');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ปิดการใช้งาน', exact: true }).click();
  await expect(page.getByText('ปิดการใช้งานตำแหน่งแล้ว')).toBeVisible();
  const deactivations = await admin.from('ci_audit_logs').select('reason').eq('entity_table', 'ci_locations').eq('action', 'DEACTIVATE').in('entity_id', [uiShelfId, uiFreezerId]);
  expect((deactivations.data ?? []).map(row => row.reason).sort()).toEqual(['E2E retire freezer', 'E2E retire shelf']);
  await page.goto(`/locations/${uiShelfId}/edit?warehouse=CHE`);
  await expect(page.getByLabel('รหัสตำแหน่ง')).toHaveValue('E2E-UI-FZ-S1');

  // ---- Phase 1: QR labels, /q/{token}, scanner guard -------------------------------------------------------------------
  await page.goto('/locations/qr?warehouse=CHE');
  await expect(page.getByText(/QR ชี้ไปที่ https:\/\/chem-immuno-cbh\.vercel\.app/)).toBeVisible();
  const activeChe = await admin.from('ci_locations').select('id', { count: 'exact', head: true }).eq('warehouse_id', 1).eq('active', true);
  await expect(page.locator('.location-label')).toHaveCount(activeChe.count!);
  await expect(page.locator('.location-label').filter({ hasText: 'E2E-FR-S1' })).toContainText('ควบคุมสภาพแวดล้อมโดย E2E-FR');
  await expect(page.locator('.location-label').filter({ hasText: 'E2E-UI-FZ-S1' }), 'closed locations are left out by default').toHaveCount(0);
  await expect(page.getByText(/ข้ามตำแหน่งที่ปิดใช้งาน/)).toBeVisible();
  const labelBox = await page.locator('.location-label').first().boundingBox();
  expect(labelBox && Math.abs(labelBox.width - (50 * 96) / 25.4) < 3 && Math.abs(labelBox.height - (30 * 96) / 25.4) < 3, 'labels are 50 x 30 mm').toBeTruthy();
  const qrSize = await page.locator('.location-label img').first().evaluate(image => (image as HTMLImageElement).getBoundingClientRect().width);
  expect(qrSize).toBeGreaterThan((22 * 96) / 25.4);
  await page.goto(`/locations/qr?warehouse=CHE&ids=${uiShelfId}&include_inactive=1`);
  await expect(page.locator('.location-label')).toHaveCount(1);
  await expect(page.locator('.location-label')).toContainText('ปิดใช้งาน');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: 'เมนูย่อย คลังสินค้า' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'พิมพ์ / บันทึก PDF' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  const fridgeToken = tokenOf(fridge.data as string);
  const shelfToken = tokenOf(fridgeShelf.data as string);
  const immToken = tokenOf(immFridge.data as string);
  await page.goto(`/q/${fridgeToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${fridge.data}\\?warehouse=CHE$`));
  await expect(page.getByRole('heading', { name: /E2E-FR/ })).toBeVisible();
  await expect(page.getByText('2 – 8 °C')).toBeVisible();
  const generic = /ไม่พบตำแหน่งนี้ หรือคุณไม่มีสิทธิ์เข้าถึง/;
  for (const bad of ['zzz', fridgeToken.toUpperCase(), fridgeToken.slice(1), '0'.repeat(32)]) {
    await page.goto(`/q/${bad}`);
    await expect(page.getByText(generic), bad).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/q/${bad}$`));
  }
  // Rotation revokes the printed label and is audited.
  await page.goto(`/locations/${fridgeShelf.data}?warehouse=CHE`);
  await page.getByLabel('เหตุผลที่เปลี่ยน QR').fill('E2E label replaced');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'เปลี่ยน QR ใหม่', exact: true }).click();
  await expect(page.getByText(/เปลี่ยน QR ใหม่แล้ว/)).toBeVisible();
  await page.goto(`/q/${shelfToken}`);
  await expect(page.getByText(generic), 'the old printed QR no longer resolves').toBeVisible();
  const newShelfToken = (await admin.from('ci_locations').select('qr_token').eq('id', fridgeShelf.data as string).single()).data!.qr_token as string;
  expect(newShelfToken).toMatch(/^[0-9a-f]{32}$/);
  expect(newShelfToken).not.toBe(shelfToken);
  await page.goto(`/q/${newShelfToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${fridgeShelf.data}\\?warehouse=CHE$`));
  expect((await admin.from('ci_audit_logs').select('reason').eq('entity_table', 'ci_locations').eq('action', 'QR_ROTATE').eq('entity_id', fridgeShelf.data as string)).data?.map(row => row.reason)).toEqual(['E2E label replaced']);

  // The product scanner never treats a Location QR as a barcode.
  const scannedQr = `https://chem-immuno-cbh.vercel.app/q/${newShelfToken}`;
  await page.goto('/scan?warehouse=CHE');
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill(scannedQr);
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText('นี่คือ QR ตำแหน่งจัดเก็บ', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'เปิดตำแหน่งนี้' })).toHaveAttribute('href', `/q/${newShelfToken}`);
  await expect(page.getByText(/ไม่พบสินค้า/)).toHaveCount(0);
  await page.goto(`/receive?invoice=${invoice.data}`);
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill(scannedQr);
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'นี่คือ QR ตำแหน่งจัดเก็บ' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เสนอการจับคู่ Barcode กับ Product ที่เลือก' }), 'no mapping proposal can be made from a Location QR').toHaveCount(0);
  expect((await admin.from('ci_identifier_mapping_requests').select('id', { count: 'exact', head: true }).ilike('identifier_value', '%/q/%')).count).toBe(0);
  expect((await admin.from('ci_scan_events').select('id', { count: 'exact', head: true }).ilike('raw_payload', '%/q/%')).count).toBe(0);

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
  // CHE staff: locations are readable, but managing them (edit, deactivate, QR labels, rotation) is for supervisors and admins only.
  await page.goto(`/locations/${fridge.data}?warehouse=CHE`);
  await expect(page.getByRole('heading', { name: /E2E-FR/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'จัดการตำแหน่ง' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'พิมพ์ QR' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ })).toBeVisible();
  await page.goto('/locations?warehouse=CHE');
  await expect(page.getByRole('link', { name: /เพิ่มแบบละเอียด/ })).toHaveCount(0);
  await expect(page.getByText('เพิ่มและแก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto('/locations/new?warehouse=CHE');
  await expect(page.getByText('เพิ่มตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto('/locations/qr?warehouse=CHE');
  await expect(page.getByText('พิมพ์ป้าย QR ได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await expect(page.locator('.location-label')).toHaveCount(0);
  await page.goto(`/locations/${fridge.data}/edit?warehouse=CHE`);
  await expect(page.getByText('แก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto(`/q/${fridgeToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${fridge.data}\\?warehouse=CHE$`));
  await page.goto(`/q/${immToken}`);
  await expect(page.getByText(generic), 'a QR from a warehouse this account cannot open looks like any unknown QR').toBeVisible();
  await expectNotFound(`/locations/${immFridge.data}`, "another warehouse's location is indistinguishable from a missing one");
  await page.goto('/');
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2esupervisor');
  await page.goto('/products?warehouse=IMM');
  await expect(page.getByRole('link', { name: 'เพิ่มสินค้า' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByText('หน้านี้ใช้ได้เฉพาะผู้ดูแลระบบที่มีสิทธิ์ทั้งสองคลัง')).toBeVisible();
  // IMM supervisor: manages IMM locations, cannot see CHE ones through a route or a QR.
  await page.goto('/locations?warehouse=IMM');
  await expect(page.getByRole('link', { name: /เพิ่มแบบละเอียด/ })).toBeVisible();
  await page.goto(`/q/${immToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${immFridge.data}\\?warehouse=IMM$`));
  await expect(page.getByRole('heading', { name: 'จัดการตำแหน่ง' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'พิมพ์ QR' })).toBeVisible();
  await page.goto(`/q/${fridgeToken}`);
  await expect(page.getByText(generic)).toBeVisible();
  await expectNotFound(`/locations/${fridge.data}`, 'another warehouse or a missing id renders the same not-found page');
  await expectNotFound(`/locations/${fridge.data}/edit`, 'another warehouse or a missing id renders the same not-found page');
  await page.goto('/');
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  // A logged-out scan goes to the login page and returns to the scanned location afterwards.
  await page.goto(`/q/${immToken}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2esupervisor');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${immFridge.data}\\?warehouse=IMM$`));
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2eviewer');
  await page.goto('/products?warehouse=CHE');
  await expect(page.getByRole('link', { name: 'เพิ่มสินค้า' })).toHaveCount(0);
  await page.goto('/scan?warehouse=CHE');
  await expect(page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ })).toHaveCount(0);
  await page.goto('/receive?warehouse=CHE');
  await expect(page.getByRole('heading', { name: 'สร้าง Invoice' })).toHaveCount(0);
  // CHE viewer: locations are readable, but managing them (edit, deactivate, QR labels, rotation) is for supervisors and admins only.
  await page.goto(`/locations/${fridge.data}?warehouse=CHE`);
  await expect(page.getByRole('heading', { name: /E2E-FR/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'จัดการตำแหน่ง' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'พิมพ์ QR' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ })).toBeVisible();
  await page.goto('/locations?warehouse=CHE');
  await expect(page.getByRole('link', { name: /เพิ่มแบบละเอียด/ })).toHaveCount(0);
  await expect(page.getByText('เพิ่มและแก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto('/locations/new?warehouse=CHE');
  await expect(page.getByText('เพิ่มตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto('/locations/qr?warehouse=CHE');
  await expect(page.getByText('พิมพ์ป้าย QR ได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await expect(page.locator('.location-label')).toHaveCount(0);
  await page.goto(`/locations/${fridge.data}/edit?warehouse=CHE`);
  await expect(page.getByText('แก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้')).toBeVisible();
  await page.goto(`/q/${fridgeToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${fridge.data}\\?warehouse=CHE$`));
  await page.goto(`/q/${immToken}`);
  await expect(page.getByText(generic), 'a QR from a warehouse this account cannot open looks like any unknown QR').toBeVisible();
  await expectNotFound(`/locations/${immFridge.data}`, "another warehouse's location is indistinguishable from a missing one");
  await page.goto('/');
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([]);
  expect(duplicateAuthClientWarnings).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
