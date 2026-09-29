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
    // Supervises both warehouses without being an admin: the "dual manager" who may manage ALL-scope Morning Talks.
    { ephis: 'e2edual', role: 'supervisor', warehouseIds: [1, 2], name: 'Synthetic dual supervisor' },
  ] as const) {
    const roleUser = await admin.auth.admin.createUser({ email: `ephis.${identity.ephis}@chem-immuno.internal`, password, email_confirm: true });
    expect(roleUser.error).toBeNull();
    const provisioned = await client.rpc('ci_provision_user', {
      p_ephis_id: identity.ephis,
      p_display_name: 'name' in identity ? identity.name : `Synthetic ${identity.role}`,
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
  // Phase 2 fixtures: real Morning Talks created through the published RPCs by the people who would create them.
  const profiles = await admin.from('ci_user_profiles').select('user_id,ephis_id');
  expect(profiles.error).toBeNull();
  const uid = (ephis: string) => profiles.data!.find(row => row.ephis_id === ephis)!.user_id as string;
  const dual = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await dual.auth.signInWithPassword({ email: 'ephis.e2edual@chem-immuno.internal', password })).error).toBeNull();
  const cancelTalk = await dual.rpc('ci_save_morning_talk', { p: { scope: 'CHE', title: 'E2E Morning Talk to cancel', attendees: [uid('e2eviewer')], checklist: [], actions: [] } });
  expect(cancelTalk.error).toBeNull();
  const cheTalk = await dual.rpc('ci_save_morning_talk', { p: { scope: 'CHE', title: 'E2E Morning Talk CHE', agenda: 'E2E agenda', attendees: [uid('e2estaff'), uid('e2eviewer'), uid('e2edual')],
    checklist: [{ title: 'ตรวจเครื่อง E2E' }, { title: 'ตรวจน้ำยา E2E' }], actions: [{ title: 'ส่งซ่อมเครื่อง E2E', owner_id: uid('e2estaff'), due_date: '2020-01-01' }] } });
  expect(cheTalk.error).toBeNull();
  const allTalk = await dual.rpc('ci_save_morning_talk', { p: { scope: 'ALL', title: 'E2E Morning Talk ALL', agenda: 'E2E all agenda', attendees: [uid('e2estaff'), uid('e2esupervisor'), uid('e2eviewer')], checklist: [{ title: 'ตรวจความพร้อมทั้งสองคลัง E2E' }], actions: [] } });
  expect(allTalk.error).toBeNull();
  const bangkokNow = new Date(Date.now() + 7 * 3600_000).toISOString();
  const bangkokMonth = bangkokNow.slice(0, 7);
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
  await expect(page.getByRole('link', { name: /^น้ำยาที่ใช้งาน 3/ })).toBeVisible();
  const dashboardMetricLabels = [
    'น้ำยาที่ใช้งาน', 'หมดสต็อก', 'ต่ำกว่า ROP', 'LOT หมดอายุแล้ว', 'หมดอายุใน 30 วัน', 'หมดอายุใน 90 วัน',
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
  await expect(page.getByRole('link', { name: /^น้ำยาที่ใช้งาน 1/ })).toBeVisible();
  await expectDashboardMetrics();

  await page.goto('/products/new?warehouse=CHE');
  await page.getByLabel('ชื่อน้ำยาตามแหล่งข้อมูล').fill('Synthetic UI product source');
  await page.getByLabel('ชื่อที่แสดง').fill('Synthetic UI product');
  await page.getByLabel('ประเภท').selectOption('control');
  await page.getByLabel('ขนาดบรรจุ (ข้อความต้นฉบับ)').fill('2 x 10 mL');
  await page.getByLabel('REF ปัจจุบัน').fill('E2E-UI-REF');
  await page.getByLabel('Manufacturer barcode').fill('E2E-UI-BARCODE');
  await page.getByRole('button', { name: 'สร้างน้ำยา' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic UI product' })).toBeVisible();
  const uiProductId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByLabel('ชื่อที่แสดง').fill('Synthetic UI product edited');
  await page.getByLabel('ประเภท').selectOption('reagent');
  await page.getByLabel('ขนาดบรรจุ').fill('3 x 20 mL');
  await page.getByRole('button', { name: 'บันทึกข้อมูลน้ำยา' }).click();
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
    '/morning-talk', '/morning-talk/history', '/morning-talk/actions', '/morning-talk/new', `/morning-talk/${cheTalk.data}`, `/morning-talk/${cheTalk.data}/edit`, `/reports/morning-talk?month=${bangkokMonth}`,
    '/environment?warehouse=CHE', '/environment/check?warehouse=CHE', `/environment/check/${fridge.data}`, '/environment/history?warehouse=CHE', '/environment/excursions?warehouse=CHE', `/reports/environment?warehouse=CHE&month=${bangkokMonth}`,
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
      if (width === 375 && ['/', '/receive?warehouse=CHE', '/reports/monthly?warehouse=CHE&month=2026-09', '/locations?warehouse=CHE', '/locations/new?warehouse=CHE', `/locations/${fridge.data}`, '/morning-talk', '/morning-talk/new'].includes(route)) {
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
  // ---- Phase 1 / 1.1: category-level sidebar accordion (desktop), mobile tab strip unchanged -----------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'เมนูหลัก' });
  const collapsibleNames = ['STOCK', 'OPERATIONS', 'MONITORING', 'REPORTS & AUDIT', 'SYSTEM'];
  const categoryButton = (name: string) => sidebar.getByRole('button', { name, exact: true });
  // /more (mobile) still groups by the seven underlying workspaces, unaffected by the desktop category refactor.
  const workspaceNames = ['ภาพรวม', 'Morning Talk', 'คลังน้ำยา', 'ปฏิบัติงาน', 'อุณหภูมิ/ความชื้น', 'รายงาน', 'จัดการระบบ'];
  await expect(sidebar.getByRole('link', { name: 'สแกน Barcode' }), 'the Scan quick action stays at the top, outside every category').toBeVisible();
  // Home is always visible and is never a button; every other category is exactly one accordion control.
  await expect(sidebar.getByText('หน้าหลัก', { exact: true })).toBeVisible();
  const homeList = sidebar.getByRole('list', { name: 'หน้าหลัก' });
  await expect(homeList.getByRole('link', { name: 'ภาพรวม', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(homeList.getByRole('link', { name: 'รายการที่ต้องติดตาม', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button'), 'exactly the five collapsible categories are buttons').toHaveCount(5);
  // On Home, no collapsible category owns the current page, so all five start collapsed and their links are hidden -
  // this is what keeps the sidebar from needing its own scrollbar on a normal desktop viewport.
  for (const name of collapsibleNames) await expect(categoryButton(name), `${name} starts collapsed`).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'คงคลัง', exact: true }), 'STOCK is collapsed, so its links are hidden').toBeHidden();
  await expect(page.getByRole('navigation', { name: /^เมนูย่อย/ }), 'no horizontal tab strip on desktop').toBeHidden();
  const stripDisplay = await page.evaluate(() => { const strip = document.querySelector('.workspace-tabs'); return strip ? getComputedStyle(strip).display : 'absent'; });
  expect(['none', 'absent']).toContain(stripDisplay);
  const sidebarFitsWithoutScroll = await page.evaluate(() => { const inner = document.querySelector('.sidebar-inner')!; return inner.scrollHeight <= inner.clientHeight + 1; });
  expect(sidebarFitsWithoutScroll, 'with every category collapsed, the sidebar fits a normal 900px-tall viewport with no scrollbar').toBe(true);

  // Section 24 sequence: /products auto-opens STOCK; clicking OPERATIONS closes STOCK and opens OPERATIONS.
  await page.goto('/products?warehouse=CHE');
  await expect(categoryButton('STOCK'), '/products auto-opens STOCK').toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('OPERATIONS')).toHaveAttribute('aria-expanded', 'false');
  await expect(categoryButton('MONITORING')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'ทะเบียนน้ำยา', exact: true })).toHaveAttribute('aria-current', 'page');
  await categoryButton('OPERATIONS').click();
  await expect(categoryButton('OPERATIONS')).toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('STOCK'), 'opening OPERATIONS closes STOCK - only one category open at a time').toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'ทะเบียนน้ำยา', exact: true }), 'STOCK links are hidden once it collapses, even though /products is still the current page').toBeHidden();
  await expect(sidebar.getByRole('link', { name: 'รับเข้า', exact: true })).toBeVisible();

  // Navigate to /receive (still OPERATIONS): it stays open, nothing resets.
  await page.goto('/receive?warehouse=CHE');
  await expect(categoryButton('OPERATIONS'), 'staying inside OPERATIONS keeps it open').toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByRole('link', { name: 'รับเข้า', exact: true })).toHaveAttribute('aria-current', 'page');

  // Then to /environment: MONITORING opens automatically, OPERATIONS closes, and the active page is never hidden.
  await page.goto('/environment?warehouse=CHE');
  await expect(categoryButton('MONITORING'), 'navigating to Environment auto-opens MONITORING').toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('OPERATIONS'), 'the previous category closes').toHaveAttribute('aria-expanded', 'false');
  // MONITORING keeps its own sub-headings, not a nested accordion: Morning Talk's and Environment's tabs render together, both visible at once.
  await expect(sidebar.getByRole('button', { name: 'Morning Talk' }), 'Morning Talk is a sub-heading, never its own accordion control').toHaveCount(0);
  const environmentList = sidebar.getByRole('list', { name: 'อุณหภูมิ/ความชื้น' });
  await expect(environmentList.getByRole('link', { name: 'ภาพรวม', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(environmentList.getByRole('link', { name: 'ตรวจด้วย QR', exact: true })).toBeVisible();
  await expect(environmentList.getByRole('link', { name: 'นอกช่วง', exact: true })).toBeVisible();
  const morningTalkList = sidebar.getByRole('list', { name: 'Morning Talk' });
  await expect(morningTalkList.getByRole('link', { name: 'วันนี้', exact: true })).toBeVisible();
  await expect(morningTalkList.getByRole('link', { name: 'งานค้าง', exact: true })).toBeVisible();

  // REPORTS & AUDIT and SYSTEM, with an authorized (Admin of both) role.
  await page.goto('/reports/monthly?warehouse=CHE&month=2026-09');
  await expect(categoryButton('REPORTS & AUDIT')).toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('MONITORING')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'รายงานรายเดือน', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'บันทึกการตรวจสอบ', exact: true })).toBeVisible();
  await page.goto('/admin/users');
  await expect(categoryButton('SYSTEM')).toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('REPORTS & AUDIT')).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'ผู้ใช้', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'นำเข้าทะเบียนน้ำยา', exact: true })).toBeVisible();

  // Keyboard: a category control is a real button, reachable by Tab, with a visible focus ring and a 44px touch target;
  // Enter and Space both operate it exactly like a click.
  await page.goto('/products?warehouse=CHE');
  const operationsButton = categoryButton('OPERATIONS');
  await operationsButton.focus();
  await expect(operationsButton).toBeFocused();
  const outline = await operationsButton.evaluate(node => getComputedStyle(node).outlineStyle);
  expect(outline).not.toBe('none');
  expect(await operationsButton.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(operationsButton).toHaveAttribute('aria-expanded', 'true');
  await expect(categoryButton('STOCK')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(operationsButton).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(operationsButton).toHaveAttribute('aria-expanded', 'true');

  // A link navigates normally, carries only the warehouse, and becomes the highlighted current page with a full-row background.
  await page.goto('/products?warehouse=CHE');
  await sidebar.getByRole('link', { name: 'คงคลัง', exact: true }).click();
  await expect(page, 'the click carries only the warehouse already selected, no stale query').toHaveURL(/\/stock(\?warehouse=CHE)?$/);
  const current = sidebar.getByRole('link', { name: 'คงคลัง', exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  const currentStyle = await current.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(currentStyle, 'the current link has a real background fill, not only a border').not.toBe('rgba(0, 0, 0, 0)');
  expect(currentStyle).not.toBe('transparent');

  // Navigating to another category's page shows it as current, and Scan is unaffected (it is not inside any category).
  await page.goto('/scan/review?warehouse=CHE');
  await expect(categoryButton('SYSTEM')).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByRole('link', { name: 'คิวอนุมัติ Barcode', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'สแกน Barcode' }), '/scan/review is not the Scan quick action').not.toHaveAttribute('aria-current', 'page');
  await expect(sidebar.getByRole('link', { name: 'นำเข้าทะเบียนน้ำยา', exact: true }), 'the rest of SYSTEM stays visible alongside the current page').toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'ผู้ใช้', exact: true })).toBeVisible();

  // Browser back/forward restore the previous page and its category; only the warehouse is carried by links.
  await page.goto('/stock?warehouse=IMM&q=zzz');
  await expect(categoryButton('STOCK')).toHaveAttribute('aria-expanded', 'true');
  await sidebar.getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true }).click();
  await expect(page).toHaveURL(/\/locations\?warehouse=IMM$/);
  await expect(sidebar.getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).toHaveURL(/\/stock\?warehouse=IMM&q=zzz$/);
  await expect(sidebar.getByRole('link', { name: 'คงคลัง', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page).toHaveURL(/\/locations\?warehouse=IMM$/);

  // Existing deep links keep working: the owning category (if any) opens automatically and highlights exactly one link.
  for (const [url, category, child] of [
    ['/vendors/evaluation-policy', 'STOCK', 'ผู้ขาย'], [`/products/${chemProduct}`, 'STOCK', 'ทะเบียนน้ำยา'], ['/counts?warehouse=CHE', 'OPERATIONS', 'ตรวจนับ'],
    ['/adjust?warehouse=CHE', 'OPERATIONS', 'ปรับยอด'], ['/reports/monthly?warehouse=CHE&month=2026-09', 'REPORTS & AUDIT', 'รายงานรายเดือน'], ['/audit?warehouse=CHE', 'REPORTS & AUDIT', 'บันทึกการตรวจสอบ'],
    ['/scan/review?warehouse=CHE', 'SYSTEM', 'คิวอนุมัติ Barcode'], ['/admin/users', 'SYSTEM', 'ผู้ใช้'], ['/attention?warehouse=CHE', null, 'รายการที่ต้องติดตาม'],
    [`/locations/${fridge.data}`, 'STOCK', 'ตำแหน่งจัดเก็บ'], ['/movements?warehouse=CHE', 'REPORTS & AUDIT', 'ประวัติเคลื่อนไหว'],
  ] as const) {
    await page.goto(url);
    if (category) {
      await expect(categoryButton(category), `${url} opens ${category}`).toHaveAttribute('aria-expanded', 'true');
      for (const other of collapsibleNames.filter(n => n !== category)) await expect(categoryButton(other), `${url}: ${other} stays closed`).toHaveAttribute('aria-expanded', 'false');
    } else {
      for (const name of collapsibleNames) await expect(categoryButton(name), `${url} (Home) opens no collapsible category`).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(sidebar.getByRole('link', { name: child, exact: true }), `${url} highlights its link`).toHaveAttribute('aria-current', 'page');
    expect(await sidebar.locator('[aria-current="page"]').count(), `${url}: exactly one current page in the sidebar`).toBe(1);
  }
  await page.goto('/scan?warehouse=CHE');
  for (const name of collapsibleNames) await expect(categoryButton(name), '/scan (outside every category) opens no collapsible category').toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByRole('link', { name: 'สแกน Barcode' })).toHaveAttribute('aria-current', 'page');
  expect(await sidebar.locator('[aria-current="page"]').count(), '/scan highlights only the Scan quick action').toBe(1);

  await page.goto('/locations?warehouse=CHE');
  await page.emulateMedia({ media: 'print' });
  await expect(sidebar).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  // Full-width desktop app shell: the sidebar sits flush at the left edge and Main fills the rest of the viewport, with no
  // large centered dead margins on a wide screen.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/stock?warehouse=CHE');
  const shellMetrics = await page.evaluate(() => {
    const aside = document.querySelector('.sidebar')!;
    const main = document.querySelector('.main-area')!;
    return { asideLeft: aside.getBoundingClientRect().left, mainRight: main.getBoundingClientRect().right, viewportWidth: window.innerWidth };
  });
  expect(shellMetrics.asideLeft, 'the sidebar begins at the left edge of the viewport').toBe(0);
  expect(shellMetrics.viewportWidth - shellMetrics.mainRight, 'Main is not stranded by a leftover centered max-width').toBeLessThan(2);

  // Narrow screens: no sidebar, the horizontal tab strip is back, the bottom bar and /more are unchanged.
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/stock?warehouse=CHE');
  await expect(sidebar, 'the sidebar is not used at tablet-portrait width').toBeHidden();
  await expect(page.getByRole('navigation', { name: 'เมนูย่อย คลังน้ำยา' }).getByRole('link')).toHaveCount(5);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/locations?warehouse=CHE');
  await expect(sidebar).toBeHidden();
  const strip = page.getByRole('navigation', { name: 'เมนูย่อย คลังน้ำยา' });
  await expect(strip.getByRole('link', { name: 'ตำแหน่งจัดเก็บ', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(strip.getByRole('link')).toHaveCount(5);
  const bottom = page.getByRole('navigation', { name: 'เมนูมือถือ' });
  await expect(bottom.getByRole('link'), 'the accepted mobile bottom navigation is unchanged').toHaveText(['ภาพรวม', 'คงคลัง', 'สแกน', 'รับเข้า', 'เพิ่มเติม']);
  await expect(bottom.getByRole('link', { name: 'คงคลัง' }), 'Stock also lights up for Inventory pages').toHaveAttribute('aria-current', 'page');
  await page.goto('/more');
  for (const heading of workspaceNames) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'คลังน้ำยา', exact: true }).getByRole('link', { name: 'ตำแหน่งจัดเก็บ' })).toBeVisible();
  await expect(page.getByRole('link', { name: /อุณหภูมิ\/ความชื้น/ }).first()).toBeVisible();
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
  const portalAnchor = page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ }).first();
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
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal.*ของ E2E-UI-FZ/ }), "the parent's Portal link is offered on the shelf").toHaveAttribute('href', portalUrl);
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
  await expect(page.getByRole('navigation', { name: 'เมนูย่อย คลังน้ำยา' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'พิมพ์ / บันทึก PDF' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  const fridgeToken = tokenOf(fridge.data as string);
  const shelfToken = tokenOf(fridgeShelf.data as string);
  const immToken = tokenOf(immFridge.data as string);
  await page.goto(`/q/${fridgeToken}`);
  await expect(page).toHaveURL(new RegExp(`/environment/check/${fridge.data}\\?warehouse=CHE&source=qr$`));
  await expect(page.getByRole('heading', { name: /E2E-FR/ })).toBeVisible();
  await expect(page.getByText('2 – 8 °C').first()).toBeVisible();
  // ---- Phase 3: native QR, in-app QR, reading, excursion and inherited shelf ------------------------------------------
  await page.getByLabel('อุณหภูมิ (°C)').fill('4.1');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'อยู่ในช่วง' })).toBeVisible();
  await page.getByRole('link', { name: 'สแกนตำแหน่งถัดไป' }).click();
  await expect(page).toHaveURL(/\/environment\/check\?warehouse=CHE$/);
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง QR/ }).fill(`/q/${shelfToken}`);
  await page.getByRole('button', { name: 'ตรวจ QR' }).click();
  await expect(page).toHaveURL(new RegExp(`/environment/check/${fridge.data}\\?source=qr&from=${fridgeShelf.data}$`));
  await expect(page.getByText(/E2E-FR-S1 อยู่ใน E2E-FR — บันทึกให้ E2E-FR/)).toBeVisible();
  await page.goto(`/environment/check/${fridgeShelf.data}`);
  await expect(page).toHaveURL(new RegExp(`/environment/check/${fridge.data}\\?from=${fridgeShelf.data}&warehouse=CHE&source=manual$`));
  await page.goto(`/q/${shelfToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${fridgeShelf.data}\\?warehouse=CHE$`));
  await expect(page.getByRole('link', { name: /บันทึกอุณหภูมิ\/ความชื้นของ E2E-FR/ })).toBeVisible();
  await page.goto(`/environment/check/${fridge.data}?warehouse=CHE`);
  await page.getByLabel('อุณหภูมิ (°C)').fill('9.0');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByText(/ค่าอยู่นอกช่วง/)).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันบันทึก' }).click();
  await expect(page.getByRole('heading', { name: 'นอกช่วง' })).toBeVisible();
  await page.getByRole('link', { name: 'ดูเหตุการณ์นอกช่วง' }).click();
  await expect(page.getByRole('heading', { name: /E2E-FR · เหตุการณ์นอกช่วง/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'รับทราบ', exact: true }), 'no separate acknowledge stage exists any more').toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ปิดเหตุการณ์' }), 'no separate Admin/Supervisor closure step exists any more').toHaveCount(0);
  await page.getByLabel('การดำเนินการแก้ไข *').fill('ตรวจตู้และย้ายน้ำยา E2E');
  await page.getByLabel('ผลหลังดำเนินการ *').fill('ติดตามอุณหภูมิและบันทึกเหตุการณ์ E2E');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByText('บันทึกการแก้ไขแล้ว').first()).toBeVisible();
  await expect(page.getByText(/ดำเนินการแล้ว/).first()).toBeVisible();
  await expect(page.getByText('การดำเนินการแก้ไข: ตรวจตู้และย้ายน้ำยา E2E')).toBeVisible();
  await expect(page.getByText('ผลหลังดำเนินการ: ติดตามอุณหภูมิและบันทึกเหตุการณ์ E2E')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการแก้ไข' }), 'a resolved excursion shows no completion form at all').toHaveCount(0);
  const fridgeExcursion = await admin.from('ci_environment_excursions').select('id').eq('location_id', fridge.data).eq('status', 'resolved').single();
  expect(fridgeExcursion.error).toBeNull();
  await page.goto('/attention?warehouse=CHE&type=env_excursion');
  await expect(page.locator(`a[href="/environment/excursions/${fridgeExcursion.data!.id}"]`), 'a resolved excursion is not listed as an unresolved one in Attention').toHaveCount(0);
  await page.goto(`/environment/history?warehouse=CHE&location=${fridge.data}`);
  await expect(page.getByText(/4\.1 °C/).first()).toBeVisible();
  await expect(page.getByText('9 °C', { exact: true }).first()).toBeVisible();
  const originalEnvironmentCard = page.locator('article').filter({ hasText: '4.1 °C' }).first();
  await originalEnvironmentCard.locator('summary').click();
  await originalEnvironmentCard.getByLabel('อุณหภูมิ °C').fill('4.2');
  await originalEnvironmentCard.getByLabel('เหตุผล').fill('แก้ไขการอ่านค่า E2E');
  await originalEnvironmentCard.getByRole('button', { name: 'ยืนยันแก้ไข' }).click();
  const correctedEnvironmentCard = page.locator('article').filter({ hasText: '4.2 °C' }).first();
  await expect(correctedEnvironmentCard.getByText(/แก้ไขจาก/)).toBeVisible();
  await correctedEnvironmentCard.locator('summary').click();
  await correctedEnvironmentCard.getByLabel('ยกเลิกข้อมูล').check();
  await correctedEnvironmentCard.getByLabel('เหตุผล').fill('ยกเลิกการอ่านค่า E2E');
  await correctedEnvironmentCard.getByRole('button', { name: 'ยืนยันยกเลิกข้อมูล' }).click();
  await expect(page.locator('article').filter({ hasText: 'ยกเลิกการอ่านค่า E2E' })).toBeVisible();
  await page.goto(`/reports/environment?warehouse=CHE&month=${bangkokMonth}&location=${fridge.data}`);
  await expect(page.getByRole('heading', { name: /รายงานอุณหภูมิ\/ความชื้นประจำเดือน/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /E2E-FR · Synthetic fridge/ })).toBeVisible();
  const pausedFridge = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-PAUSED-FR', name: 'Synthetic paused fridge', location_type: 'refrigerator', env: rangeEnv } });
  expect(pausedFridge.error).toBeNull();
  const pausedConfig = await client.rpc('ci_set_location_env_config', { p_location_id: pausedFridge.data, p: { monitoring_state: 'paused', pause_reason: 'ตรวจเครื่อง E2E' } });
  expect(pausedConfig.error).toBeNull();
  const pausedToken = (await admin.from('ci_locations').select('qr_token').eq('id', pausedFridge.data as string).single()).data!.qr_token as string;
  await page.goto(`/q/${pausedToken}`);
  await expect(page).toHaveURL(new RegExp(`/locations/${pausedFridge.data}\\?warehouse=CHE$`));
  await expect(page.getByRole('link', { name: /บันทึกอุณหภูมิ\/ความชื้น/ })).toHaveCount(0);
  await page.goto('/environment/check?warehouse=CHE');
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง QR/ }).fill(`/q/${pausedToken}`);
  await page.getByRole('button', { name: 'ตรวจ QR' }).click();
  await expect(page.getByRole('link', { name: 'ดูรายละเอียดตำแหน่ง' })).toHaveAttribute('href', `/locations/${pausedFridge.data}`);
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
  await expect(page.getByText(/ไม่พบน้ำยา/)).toHaveCount(0);
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
  await expect(page.getByRole('heading', { name: 'ตรวจและรับน้ำยา' })).toBeVisible();
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
    await expect(page.getByText(/ไม่พบน้ำยา/).first()).toBeVisible();
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
  await expect(page.getByText(/ไม่พบน้ำยา/).first()).toBeVisible();
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
  await expect(page.getByText(/ไม่พบน้ำยา/).first()).toBeVisible();

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
  const addRelation = page.getByRole('combobox', { name: 'ความสัมพันธ์จากน้ำยานี้' }).first();
  await addRelation.selectOption('uses_calibrator');
  const targetSearch = page.getByLabel('ค้นหาเป้าหมาย').first();
  await targetSearch.fill('Synthetic CHE calibrator');
  const target = page.getByLabel('น้ำยาเป้าหมาย').first();
  await expect(target.getByRole('option', { name: /CHE-0003/ })).toHaveCount(1);
  await expect(target.getByRole('option', { name: /CHE-0002/ })).toHaveCount(0);
  await target.selectOption(chemCalibrator);
  await page.getByRole('button', { name: 'เพิ่มความสัมพันธ์' }).click();
  await expect(page.locator('section.surface').filter({ hasText: 'Related Products' }).locator('span.badge').filter({ hasText: 'ใช้ Calibrator' })).toBeVisible();
  const relationRow = await admin.from('ci_product_relations').select('id').eq('source_product_id', chemProduct).eq('target_product_id', chemCalibrator).single();
  expect(relationRow.error).toBeNull();
  await page.getByText('แก้ไข', { exact: true }).first().click();
  const editRelation = page.getByRole('combobox', { name: 'ความสัมพันธ์จากน้ำยานี้' }).first();
  await editRelation.selectOption('compatible_with');
  const editSearch = page.getByLabel('ค้นหาเป้าหมาย').first();
  await editSearch.fill('Synthetic CHE two');
  const editTarget = page.getByLabel('น้ำยาเป้าหมาย').first();
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


  // ---- Phase 2: Morning Talk as a dual-warehouse manager (admin of both warehouses) ----------------------------------------------
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: /^วันนี้ Morning Talk: มี 3 รายการวันนี้/ }), 'the compact dashboard line').toBeVisible();
  await page.goto('/morning-talk/history');
  const talkSidebar = page.getByRole('navigation', { name: 'เมนูหลัก' });
  const talkCategoryButton = (name: string) => talkSidebar.getByRole('button', { name, exact: true });
  await expect(talkCategoryButton('MONITORING'), '/morning-talk/history auto-opens MONITORING (Morning Talk and Environment share it)').toHaveAttribute('aria-expanded', 'true');
  // Morning Talk and Environment both label a tab "ประวัติ", and both now render together under MONITORING with their own
  // sub-heading, so it is scoped to Morning Talk's own list (named by its sub-heading) to disambiguate. The reports
  // category also has an unrelated "Morning Talk" link, so the sub-heading itself is asserted through the list it names.
  const monitoringList = talkSidebar.getByRole('list', { name: 'Morning Talk' });
  await expect(monitoringList, 'Morning Talk gets its own sub-heading under MONITORING').toBeVisible();
  await expect(monitoringList.getByRole('link', { name: 'วันนี้', exact: true })).toBeVisible();
  await expect(monitoringList.getByRole('link', { name: 'ประวัติ', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(monitoringList.getByRole('link', { name: 'งานค้าง', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: /^เมนูย่อย/ }), 'no horizontal tab strip on desktop').toBeHidden();
  await page.goto('/reports/morning-talk?month=' + bangkokMonth);
  await expect(talkCategoryButton('REPORTS & AUDIT'), '/reports/morning-talk auto-opens REPORTS & AUDIT').toHaveAttribute('aria-expanded', 'true');
  await expect(talkCategoryButton('MONITORING'), 'the previous category closes').toHaveAttribute('aria-expanded', 'false');
  await expect(talkSidebar.getByRole('link', { name: 'Morning Talk', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.goto('/morning-talk');
  await expect(page.getByRole('heading', { name: 'Morning Talk วันนี้' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'E2E Morning Talk CHE' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'E2E Morning Talk ALL' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /รอให้คุณรับทราบ/ }), 'the admin is not an attendee, so there is nothing to acknowledge').toHaveCount(0);
  await expect(page.getByText('รับทราบ 0/3').first(), 'attendee progress x/y').toBeVisible();

  // A manager can tick the checklist; the copy that follows must not inherit that state.
  await page.goto(`/morning-talk/${cheTalk.data}`);
  await page.getByRole('checkbox', { name: /ตรวจเครื่อง E2E/ }).click();
  await expect(page.getByRole('checkbox', { name: /ตรวจเครื่อง E2E/ })).toBeChecked();
  await expect(page.getByText(/เสร็จเมื่อ/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toBeVisible();

  // Create from the UI: ALL is offered because this account supervises both warehouses; copy-from-previous brings agenda + checklist only.
  await page.goto('/morning-talk/new');
  const scopeSelect = page.getByLabel('ขอบเขต');
  await expect(scopeSelect.locator('option')).toHaveText([/ทั้งสองคลัง/, /Clinical Chemistry/, /Immunology/]);
  await scopeSelect.selectOption('CHE');
  await page.getByRole('button', { name: 'คัดลอกหัวข้อจากครั้งก่อน' }).click();
  await expect(page.getByLabel('รายการตรวจสอบข้อ 1')).toHaveValue('ตรวจเครื่อง E2E');
  await expect(page.getByLabel('รายการตรวจสอบข้อ 2')).toHaveValue('ตรวจน้ำยา E2E');
  await expect(page.getByLabel(/วาระ/)).toHaveValue('E2E agenda');
  await page.getByLabel('หัวข้อ', { exact: true }).fill('E2E Morning Talk จากหน้าเว็บ');
  await page.getByRole('button', { name: 'ทุกคนในขอบเขต' }).click();
  await expect(page.getByRole('checkbox', { name: /Synthetic staff/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Synthetic supervisor$/ }), 'an IMM-only user is not offered for a CHE talk').toHaveCount(0);
  await page.getByRole('button', { name: 'เพิ่มงาน' }).click();
  await page.getByLabel('งานที่ต้องทำ').fill('ตรวจตู้เย็น E2E');
  const ownerOptions = await page.getByLabel('ผู้รับผิดชอบ').locator('option').allTextContents();
  expect(ownerOptions.join('|'), 'a viewer can attend but is never offered as an action owner').not.toContain('Synthetic viewer');
  await page.getByLabel('ผู้รับผิดชอบ').selectOption({ label: 'Synthetic staff' });
  await page.getByRole('button', { name: 'สร้าง Morning Talk' }).click();
  await expect(page).toHaveURL(/\/morning-talk\/[0-9a-f-]{36}\?/);
  await expect(page.getByText(/สร้าง Morning Talk แล้ว/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'E2E Morning Talk จากหน้าเว็บ' })).toBeVisible();
  await expect(page.getByText(/ผู้เข้าร่วม · รับทราบ 0\/\d+/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /ตรวจเครื่อง E2E/ }), 'the copied checklist starts unticked').not.toBeChecked();
  // Edit: rename, keep everything else; the stale-version guard is exercised by the database suite.
  await page.getByRole('link', { name: 'แก้ไข', exact: true }).click();
  await expect(page.getByLabel('ขอบเขต')).toHaveAttribute('readonly', '');
  await page.getByLabel('หัวข้อ', { exact: true }).fill('E2E Morning Talk จากหน้าเว็บ (แก้ไข)');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Morning Talk จากหน้าเว็บ (แก้ไข)' })).toBeVisible();
  await expect(page.getByText(/บันทึกการแก้ไขแล้ว/)).toBeVisible();

  // Cancel needs a reason, is confirmed, and never deletes.
  await page.goto(`/morning-talk/${cancelTalk.data}`);
  page.once('dialog', dialog => void dialog.accept());
  await page.getByLabel('เหตุผลที่ยกเลิก').fill('จัดผิดวัน E2E');
  await page.getByRole('button', { name: 'ยกเลิก Morning Talk', exact: true }).click();
  await expect(page.getByText('ยกเลิก Morning Talk แล้ว')).toBeVisible();
  await expect(page.getByText(/ยกเลิกแล้ว/).first()).toBeVisible();
  await expect(page.getByText(/เหตุผล: จัดผิดวัน E2E/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true }), 'a cancelled talk cannot be edited').toHaveCount(0);

  // History: search, scope filter and the cancelled badge.
  await page.goto('/morning-talk/history?q=E2E');
  await expect(page.getByRole('link', { name: /E2E Morning Talk CHE/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E Morning Talk to cancel/ })).toContainText('ยกเลิกแล้ว');
  await page.goto('/morning-talk/history?q=' + encodeURIComponent('ทั้งสองคลัง E2E'));
  await expect(page.getByText('ไม่พบ Morning Talk ตามเงื่อนไขที่เลือก')).toBeVisible();
  await page.goto('/morning-talk/history?scope=ALL');
  await expect(page.getByRole('link', { name: /E2E Morning Talk ALL/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E Morning Talk CHE/ })).toHaveCount(0);
  await page.goto('/morning-talk/history?scope=IMM');
  await expect(page.getByText('ไม่พบ Morning Talk ตามเงื่อนไขที่เลือก')).toBeVisible();

  // Open actions: overdue first with an icon + word, filters, and a link back to the talk.
  await page.goto('/morning-talk/actions');
  const overdueRow = page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' });
  await expect(overdueRow.getByText('เกินกำหนด').first()).toBeVisible();
  await expect(overdueRow.getByRole('link', { name: /จาก: E2E Morning Talk CHE/ })).toBeVisible();
  await page.goto('/morning-talk/actions?mine=1');
  await expect(page.getByText('ไม่มีงานค้างตามเงื่อนไขนี้')).toBeVisible();
  await page.goto('/morning-talk/actions?overdue=1&scope=CHE');
  await expect(page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'ตรวจตู้เย็น E2E' }), 'an action without a due date is not overdue').toHaveCount(0);

  // Attention: a manager sees the overdue action of a scope they manage even though they do not own it.
  await page.goto('/attention?warehouse=CHE&type=mt_overdue');
  await expect(page.getByRole('link', { name: /ส่งซ่อมเครื่อง E2E/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^งาน Morning Talk เกินกำหนด 1$/ })).toBeVisible();
  await page.goto('/attention?warehouse=CHE&type=mt_unack');
  // The admin picked "everyone in scope" for the talk created above, so that talk (and only that one) awaits their own acknowledgement.
  await expect(page.getByRole('link', { name: /^E2E Morning Talk จากหน้าเว็บ \(แก้ไข\)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Morning Talk รอรับทราบ 1$/ })).toBeVisible();

  // Printable report.
  await page.goto('/reports/morning-talk?month=' + bangkokMonth);
  await expect(page.getByRole('heading', { name: 'รายงาน Morning Talk ประจำเดือน' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E Morning Talk CHE' })).toBeVisible();
  const talkReportPdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
  expect(talkReportPdf.length).toBeGreaterThan(1000);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'พิมพ์ / บันทึก PDF' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.goto('/reports/morning-talk?month=2026-13');
  await expect(page.getByText('เดือนรายงานไม่ถูกต้อง')).toBeVisible();
  await page.goto('/morning-talk/not-a-uuid');
  await expect(page.getByRole('heading', { name: 'ไม่พบข้อมูลที่ต้องการ' })).toBeVisible();

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
  await expect(page.getByRole('link', { name: 'เพิ่มน้ำยา' })).toHaveCount(0);
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
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ }).first()).toBeVisible();
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
  await expect(page).toHaveURL(new RegExp(`/environment/check/${fridge.data}\\?warehouse=CHE&source=qr$`));
  await page.goto(`/q/${immToken}`);
  await expect(page.getByText(generic), 'a QR from a warehouse this account cannot open looks like any unknown QR').toBeVisible();
  await expectNotFound(`/locations/${immFridge.data}`, "another warehouse's location is indistinguishable from a missing one");
  // ---- Phase 2: Morning Talk as CHE staff on a phone ----------------------------------------------------------------------------
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.getByText(/Morning Talk: รับทราบแล้ว 0\/3 · ยังไม่รับทราบ 3/)).toBeVisible();
  await page.goto('/morning-talk');
  await expect(page.getByRole('link', { name: /สร้าง Morning Talk/ }), 'staff cannot create').toHaveCount(0);
  await expect(page.getByRole('heading', { name: /รอให้คุณรับทราบ \(3\)/ }), 'the prominent acknowledge card').toBeVisible();
  await expect(page.getByText(/ไม่ใช่การลงนาม/)).toBeVisible();
  await page.getByRole('button', { name: 'รับทราบ' }).first().click();
  await expect(page.getByRole('heading', { name: /รอให้คุณรับทราบ \(2\)/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no horizontal overflow at 375px').toBeLessThanOrEqual(2);
  // The sticky acknowledge button on the talk page.
  await page.goto(`/morning-talk/${allTalk.data}`);
  const ackButton = page.getByRole('button', { name: 'รับทราบ', exact: true });
  await expect(ackButton).toBeVisible();
  const ackBox = await ackButton.boundingBox();
  expect(ackBox && ackBox.height >= 44, 'the acknowledge target is at least 44px').toBeTruthy();
  await ackButton.click();
  await expect(page.getByText(/รับทราบแล้ว · /).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'รับทราบ', exact: true })).toHaveCount(0);
  await page.goto('/attention?warehouse=CHE&type=mt_unack');
  await expect(page.getByRole('link', { name: /^E2E Morning Talk จากหน้าเว็บ/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Morning Talk รอรับทราบ 1$/ })).toBeVisible();
  // An attendee with work rights ticks the checklist, and the owner completes their own overdue action.
  await page.goto(`/morning-talk/${cheTalk.data}`);
  await page.getByRole('checkbox', { name: /ตรวจน้ำยา E2E/ }).click();
  await expect(page.getByRole('checkbox', { name: /ตรวจน้ำยา E2E/ })).toBeChecked();
  const ownRow = page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' });
  await expect(ownRow.getByText('เกินกำหนด').first()).toBeVisible();
  await ownRow.getByLabel('สถานะ').selectOption('done');
  await ownRow.getByLabel('หมายเหตุ').fill('ซ่อมแล้ว E2E');
  await ownRow.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' }).getByText('เสร็จแล้ว').first()).toBeVisible();
  await expect(page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' }).getByText('เกินกำหนด')).toHaveCount(0);
  await page.goto('/morning-talk/actions?mine=1');
  await expect(page.locator('li', { hasText: 'ตรวจตู้เย็น E2E' }), 'an open action assigned to me is listed').toBeVisible();
  await expect(page.locator('li', { hasText: 'ส่งซ่อมเครื่อง E2E' }), 'a completed action leaves the open list').toHaveCount(0);
  // No management surface: create, edit and cancel are hidden and routed away.
  await page.goto('/morning-talk/new');
  await expect(page).toHaveURL(/\/morning-talk$/);
  await page.goto(`/morning-talk/${cheTalk.data}/edit`);
  await expect(page).toHaveURL(new RegExp(`/morning-talk/${cheTalk.data}$`));
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ยกเลิก Morning Talk นี้' })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2esupervisor');
  await page.goto('/products?warehouse=IMM');
  await expect(page.getByRole('link', { name: 'เพิ่มน้ำยา' })).toBeVisible();
  await page.goto('/admin/users');
  await expect(page.getByText('หน้านี้ใช้ได้เฉพาะผู้ดูแลระบบที่มีสิทธิ์ทั้งสองคลัง')).toBeVisible();
  // IMM supervisor: manages IMM locations, cannot see CHE ones through a route or a QR.
  await page.goto('/locations?warehouse=IMM');
  await expect(page.getByRole('link', { name: /เพิ่มแบบละเอียด/ })).toBeVisible();
  await page.goto(`/q/${immToken}`);
  await expect(page).toHaveURL(new RegExp(`/environment/check/${immFridge.data}\\?warehouse=IMM&source=qr$`));
  await expect(page.getByRole('heading', { name: /E2E-IMM-FR/ })).toBeVisible();
  await page.goto(`/q/${fridgeToken}`);
  await expect(page.getByText(generic)).toBeVisible();
  await expectNotFound(`/locations/${fridge.data}`, 'another warehouse or a missing id renders the same not-found page');
  await expectNotFound(`/locations/${fridge.data}/edit`, 'another warehouse or a missing id renders the same not-found page');
  // ---- Phase 2: Morning Talk as an IMM-only supervisor ---------------------------------------------------------------------------
  await page.goto('/morning-talk/new');
  await expect(page.getByLabel('ขอบเขต').locator('option'), 'ALL and CHE are hidden from a single-warehouse supervisor').toHaveText([/Immunology/]);
  await page.goto(`/morning-talk/${allTalk.data}`);
  await expect(page.getByRole('heading', { name: 'E2E Morning Talk ALL' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true }), 'an ALL talk can be read but not edited by a single-warehouse supervisor').toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ยกเลิก Morning Talk นี้' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'รับทราบ', exact: true }), 'but they can acknowledge for themselves when assigned').toBeVisible();
  await page.goto(`/morning-talk/${allTalk.data}/edit`);
  await expect(page).toHaveURL(new RegExp(`/morning-talk/${allTalk.data}$`));
  await expectNotFound(`/morning-talk/${cheTalk.data}`, 'a CHE talk is invisible to an IMM-only account');
  await page.goto('/morning-talk/history?q=E2E');
  await expect(page.getByRole('link', { name: /E2E Morning Talk ALL/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /E2E Morning Talk CHE/ })).toHaveCount(0);
  await page.goto('/');
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  // A logged-out scan goes to the login page and returns to the scanned location afterwards.
  await page.goto(`/q/${immToken}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2esupervisor');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page).toHaveURL(new RegExp(`/environment/check/${immFridge.data}\\?warehouse=IMM&source=qr$`));
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await signInAs('e2eviewer');
  await page.goto('/products?warehouse=CHE');
  await expect(page.getByRole('link', { name: 'เพิ่มน้ำยา' })).toHaveCount(0);
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
  await expect(page.getByRole('link', { name: /เปิดเครื่องมือใน Portal/ }).first()).toBeVisible();
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
  // A Viewer sees the resolved excursion's evidence read-only: no completion form, no button, ever.
  await page.goto(`/environment/excursions/${fridgeExcursion.data!.id}`);
  await expect(page.getByRole('heading', { name: /E2E-FR · เหตุการณ์นอกช่วง/ })).toBeVisible();
  await expect(page.getByText('การดำเนินการแก้ไข: ตรวจตู้และย้ายน้ำยา E2E')).toBeVisible();
  await expect(page.getByText('ผลหลังดำเนินการ: ติดตามอุณหภูมิและบันทึกเหตุการณ์ E2E')).toBeVisible();
  await expect(page.getByRole('button', { name: 'บันทึกการแก้ไข' })).toHaveCount(0);
  // ---- Phase 2: Morning Talk as a viewer ------------------------------------------------------------------------------------------
  await page.goto(`/morning-talk/${cheTalk.data}`);
  await expect(page.getByRole('checkbox', { name: /ตรวจเครื่อง E2E/ }), 'a viewer cannot tick the checklist').toBeDisabled();
  await expect(page.getByLabel('สถานะ'), 'a viewer cannot update actions').toHaveCount(0);
  await expect(page.getByRole('link', { name: 'แก้ไข', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'รับทราบ', exact: true }), 'a viewer can acknowledge their own attendance').toBeVisible();
  await page.getByRole('button', { name: 'รับทราบ', exact: true }).click();
  await expect(page.getByText(/รับทราบแล้ว · /).first()).toBeVisible();
  await page.goto('/attention?warehouse=CHE&type=mt_overdue');
  await expect(page.getByText('ไม่มีงานเกินกำหนด')).toBeVisible();
  await page.goto('/morning-talk/new');
  await expect(page).toHaveURL(/\/morning-talk$/);
  await page.goto('/');
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations)).toEqual([]);
  expect(duplicateAuthClientWarnings).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

// ---- Post-Phase-3: Environment monthly charts (local disposable data only) ---------------------------------------------------
// Runs after the test above in the same worker, reusing its synthetic accounts. Historical configuration versions and readings are
// written with the local service role because the recording RPC only accepts observations from the last 72 hours; statuses are the
// ones the RPC would have stored for each version. Fixtures sit on Bangkok month boundaries (the previous month is always complete),
// so the test does not depend on today's date.
test('environment monthly charts: month views, metrics, versioned ranges, corrections, voids and inherited shelves', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const baseUrl = process.env.CI_E2E_BASE_URL || 'http://localhost:3100';
  const origin = new URL(baseUrl).origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 500 && response.url().startsWith(origin)) serverErrors.push(`${response.status()} ${response.url()}`); });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password = process.env.CI_E2E_PASSWORD!;
  if (!url || !service || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) throw new Error('Disposable local Supabase required');
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await client.auth.signInWithPassword({ email: 'ephis.e2eadmin@chem-immuno.internal', password })).error).toBeNull();
  const adminId = (await admin.from('ci_user_profiles').select('user_id').eq('ephis_id', 'e2eadmin').single()).data!.user_id as string;

  // Bangkok calendar helpers.
  const TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const shiftMonth = (month: string, by: number) => { const [y, m] = month.split('-').map(Number); const total = y * 12 + m - 1 + by; return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`; };
  const monthLabel = (month: string) => `${TH[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
  const monthDays = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const bkk = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
  const thisMonth = bkk(new Date().toISOString()).slice(0, 7);
  const prevMonth = shiftMonth(thisMonth, -1);
  const olderMonth = shiftMonth(thisMonth, -2);
  const at = (month: string, day: number, hour = 9) => new Date(`${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+07:00`).toISOString();
  const justNow = new Date(Date.now() - 60_000).toISOString();

  const create = async (p: Record<string, unknown>) => {
    const created = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, ...p } });
    expect(created.error).toBeNull();
    return created.data as string;
  };
  const tempOnly = await create({ code: 'E2E-TR-T', name: 'Synthetic trend fridge', location_type: 'refrigerator', env: { temperature_monitored: true, temp_min_c: 2, temp_max_c: 6, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null } });
  const shelf = await create({ code: 'E2E-TR-T-S1', name: 'Synthetic trend shelf', location_type: 'shelf', parent_location_id: tempOnly });
  const rhOnly = await create({ code: 'E2E-TR-H', name: 'Synthetic humidity room', location_type: 'room', env: { temperature_monitored: false, temp_min_c: null, temp_max_c: null, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 60 } });
  const both = await create({ code: 'E2E-TR-B', name: 'Synthetic both room', location_type: 'room', env: { temperature_monitored: true, temp_min_c: 15, temp_max_c: 25, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 70 } });
  // Earlier versions (the versions created above are in force from now on): E2E-TR-T was 2–8 °C until the 15th of last month,
  // then 2–6 °C; the other two had the same ranges as today since before last month.
  const versions = await admin.from('ci_location_env_configs').insert([
    { warehouse_id: 1, location_id: tempOnly, effective_from: at(olderMonth, 20, 0), temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, created_by: adminId },
    { warehouse_id: 1, location_id: tempOnly, effective_from: at(prevMonth, 15, 0), temperature_monitored: true, temp_min_c: 2, temp_max_c: 6, humidity_monitored: false, created_by: adminId },
    { warehouse_id: 1, location_id: rhOnly, effective_from: at(olderMonth, 1, 0), temperature_monitored: false, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 60, created_by: adminId },
    { warehouse_id: 1, location_id: both, effective_from: at(olderMonth, 1, 0), temperature_monitored: true, temp_min_c: 15, temp_max_c: 25, humidity_monitored: true, rh_min_pct: 30, rh_max_pct: 70, created_by: adminId },
  ]).select('id,location_id,effective_from');
  expect(versions.error).toBeNull();
  const version = (location: string, from: string) => versions.data!.find(row => row.location_id === location && Date.parse(row.effective_from) === Date.parse(from))!.id as string;
  const [v28, v26, rhConfig, bothConfig] = [version(tempOnly, at(olderMonth, 20, 0)), version(tempOnly, at(prevMonth, 15, 0)), version(rhOnly, at(olderMonth, 1, 0)), version(both, at(olderMonth, 1, 0))];
  type Row = { id?: string; location_id: string; config_id: string; observed_at: string; recorded_at?: string; entry_kind?: string; corrects_reading_id?: string;
    temperature_c?: number | null; humidity_rh?: number | null; temperature_status: string; humidity_status: string; overall_status: string; entry_mode?: string; reason?: string };
  const insert = async (rows: Row[]) => {
    const result = await admin.from('ci_environment_readings').insert(rows.map(row => ({
      warehouse_id: 1, check_date: bkk(row.observed_at), source: 'manual', recorded_by: adminId,
      // Every row carries every key: a bulk insert fills a key missing from one row with null, not with the column default.
      id: row.id ?? crypto.randomUUID(), client_request_id: crypto.randomUUID(), recorded_at: row.recorded_at ?? row.observed_at,
      corrects_reading_id: row.corrects_reading_id ?? null, reason: row.reason ?? null, temperature_c: row.temperature_c ?? null, humidity_rh: row.humidity_rh ?? null,
      location_id: row.location_id, config_id: row.config_id, observed_at: row.observed_at, entry_kind: row.entry_kind ?? 'original', entry_mode: row.entry_mode ?? 'live',
      temperature_status: row.temperature_status, humidity_status: row.humidity_status, overall_status: row.overall_status,
    })));
    expect(result.error).toBeNull();
  };
  const t = (temperature_c: number, status: string) => ({ temperature_c, temperature_status: status, humidity_status: 'not_monitored', overall_status: status });
  const [origId, voidedId] = [crypto.randomUUID(), crypto.randomUUID()];
  await insert([
    // Last month, E2E-TR-T: two readings on the 3rd, one on the 4th, nothing on the 5th–7th, then the 8th, 18th, 20th, 22nd, 25th.
    { location_id: tempOnly, config_id: v28, observed_at: at(prevMonth, 3, 9), ...t(7.5, 'in_range') }, // in range under 2–8, would be out under 2–6
    { location_id: tempOnly, config_id: v28, observed_at: at(prevMonth, 3, 15), ...t(5, 'in_range') },
    { location_id: tempOnly, config_id: v28, observed_at: at(prevMonth, 4, 9), ...t(5.5, 'in_range') },
    { location_id: tempOnly, config_id: v28, observed_at: at(prevMonth, 8, 9), ...t(6, 'in_range') },
    { location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 18, 9), ...t(7, 'out_of_range') },
    { location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 20, 9), recorded_at: at(prevMonth, 21, 10), entry_mode: 'late', reason: 'E2E late chart entry', ...t(4, 'in_range') },
    { id: origId, location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 22, 9), ...t(3.3, 'in_range') },
    { id: voidedId, location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 25, 9), ...t(11.11, 'out_of_range') },
    { location_id: tempOnly, config_id: v26, observed_at: justNow, ...t(4.5, 'in_range') },
    { location_id: rhOnly, config_id: rhConfig, observed_at: at(prevMonth, 5, 9), humidity_rh: 45, temperature_status: 'not_monitored', humidity_status: 'in_range', overall_status: 'in_range' },
    { location_id: rhOnly, config_id: rhConfig, observed_at: at(prevMonth, 6, 9), humidity_rh: 65, temperature_status: 'not_monitored', humidity_status: 'out_of_range', overall_status: 'out_of_range' },
    { location_id: rhOnly, config_id: rhConfig, observed_at: justNow, humidity_rh: 50, temperature_status: 'not_monitored', humidity_status: 'in_range', overall_status: 'in_range' },
    { location_id: both, config_id: bothConfig, observed_at: at(prevMonth, 4, 9), temperature_c: 21, humidity_rh: null, temperature_status: 'in_range', humidity_status: 'missing', overall_status: 'incomplete', reason: 'E2E hygrometer missing' },
    { location_id: both, config_id: bothConfig, observed_at: at(prevMonth, 10, 9), temperature_c: 20, humidity_rh: 50, temperature_status: 'in_range', humidity_status: 'in_range', overall_status: 'in_range' },
    { location_id: both, config_id: bothConfig, observed_at: at(prevMonth, 11, 9), temperature_c: 22, humidity_rh: null, temperature_status: 'in_range', humidity_status: 'missing', overall_status: 'incomplete', reason: 'E2E hygrometer missing' },
    { location_id: both, config_id: bothConfig, observed_at: at(prevMonth, 12, 9), temperature_c: 23, humidity_rh: 55, temperature_status: 'in_range', humidity_status: 'in_range', overall_status: 'in_range' },
    { location_id: both, config_id: bothConfig, observed_at: justNow, temperature_c: 22, humidity_rh: 48, temperature_status: 'in_range', humidity_status: 'in_range', overall_status: 'in_range' },
  ]);
  await insert([
    { location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 22, 9), recorded_at: at(prevMonth, 22, 10), entry_kind: 'correction', corrects_reading_id: origId, reason: 'E2E chart correction', ...t(3.4, 'in_range') },
    { location_id: tempOnly, config_id: v26, observed_at: at(prevMonth, 25, 9), recorded_at: at(prevMonth, 25, 10), entry_kind: 'void', corrects_reading_id: voidedId, reason: 'E2E void chart', temperature_c: null, temperature_status: 'out_of_range', humidity_status: 'not_monitored', overall_status: 'void' },
  ]);

  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2eadmin');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const metricNav = page.getByRole('navigation', { name: 'เลือกค่าที่แสดงในกราฟ' });
  const periodNav = page.getByRole('navigation', { name: 'เลือกเดือนหรือช่วงเวลา' });
  const chart = (metric: string) => page.locator(`figure.trend-chart[data-metric="${metric}"]:not(.trend-empty)`);
  const params = () => new URL(page.url()).searchParams;

  // Default: the whole CURRENT month, not a rolling window. Temperature only: one °C card, no metric switch.
  await page.goto(`/environment/history?warehouse=CHE&location=${tempOnly}`);
  await expect(page.getByRole('heading', { name: 'กราฟแนวโน้ม · E2E-TR-T' })).toBeVisible();
  await expect(periodNav.getByRole('link', { name: 'เดือนนี้' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByLabel('เลือกเดือน', { exact: true })).toHaveValue(thisMonth);
  await expect(metricNav, 'no pointless metric switch for a temperature-only location').toHaveCount(0);
  await expect(chart('temperature')).toHaveCount(1);
  await expect(chart('humidity')).toHaveCount(0);
  const tempCard = chart('temperature');
  await expect(tempCard.locator('figcaption')).toContainText('Temperature (°C)');
  await expect(tempCard.locator('figcaption')).toContainText(monthLabel(thisMonth));
  await expect(tempCard.locator('figcaption')).toContainText('ล่าสุด 4.50 °C');
  await expect(tempCard.locator('svg[role="img"]'), 'the axis is the whole month').toHaveAttribute('data-axis-days', String(monthDays(thisMonth)));
  await expect(tempCard.locator('.trend-point')).toHaveCount(1);
  await expect(tempCard.locator('.trend-future'), 'the rest of the current month is shown, marked as not yet happened').toHaveCount(1);
  await expect(page.getByRole('img', { name: /อุณหภูมิของ E2E-TR-T/ })).toBeVisible();

  // Previous month: the full month, with the versioned range, gaps, correction, void and late entry.
  await periodNav.getByRole('link', { name: 'เดือนก่อน' }).click();
  await expect(page).toHaveURL(new RegExp(`warehouse=CHE&location=${tempOnly}&range=month&month=${prevMonth}&metric=temperature`));
  await expect(periodNav.getByRole('link', { name: 'เดือนก่อน' })).toHaveAttribute('aria-current', 'true');
  await expect(tempCard.locator('figcaption')).toContainText(monthLabel(prevMonth));
  await expect(tempCard.locator('svg[role="img"]')).toHaveAttribute('data-axis-days', String(monthDays(prevMonth)));
  await expect(tempCard.locator('.trend-future'), 'a finished month has no future part').toHaveCount(0);
  const points = tempCard.locator('.trend-point');
  await expect(points, 'the voided and the superseded readings are not plotted; two readings on one day are two points').toHaveCount(7);
  await expect(tempCard.locator('.trend-point[data-corrected="true"]')).toHaveCount(1);
  await expect(tempCard.locator('.trend-point[data-late="true"]')).toHaveCount(1);
  await expect(tempCard.locator('.trend-point[data-status="out_of_range"]')).toHaveCount(1);
  await expect(tempCard.locator('polyline'), 'days without a reading break the line (3rd–4th | 8th | 18th | 20th | 22nd)').toHaveCount(5);
  const bands = tempCard.locator('.trend-band');
  await expect(bands, '2–8 until the 15th, 2–6 afterwards — never today’s 2–6 painted over the whole month').toHaveCount(2);
  await expect(bands.nth(0)).toHaveAttribute('data-band-max', '8');
  await expect(bands.nth(1)).toHaveAttribute('data-band-max', '6');
  await expect(tempCard.locator('.trend-band-change')).toHaveCount(1);
  await expect(tempCard.locator('.trend-zone-high'), 'the zone above max is tinted').toHaveCount(2);
  await expect(tempCard.locator('.trend-zone-low'), 'the zone below min is tinted').toHaveCount(2);
  await expect(tempCard.locator('.trend-limit-labels')).toContainText('max 6');
  await expect(tempCard.locator('.trend-limit-labels')).toContainText('min 2');
  await expect(tempCard.locator('.trend-summary')).toContainText('7 จุด · นอกช่วง 1 จุด');
  await tempCard.locator('summary').click();
  const table = tempCard.locator('table');
  await expect(table.locator('tbody tr')).toHaveCount(7);
  await expect(table.locator('tr').filter({ hasText: '7.50' })).toContainText('2.00 – 8.00 °C');
  await expect(table.locator('tr').filter({ hasText: '7.50' })).toContainText('อยู่ในช่วง');
  await expect(table.locator('tr').filter({ hasText: '7.00' })).toContainText('2.00 – 6.00 °C');
  await expect(table.locator('tr').filter({ hasText: '3.40' })).toContainText('แก้ไขแล้ว');
  await expect(table.locator('tr').filter({ hasText: '4.00' })).toContainText('ย้อนหลัง');
  await expect(table, 'the voided value is not a trend point').not.toContainText('11.11');
  await expect(table, 'the corrected original is not plotted twice').not.toContainText('3.30');
  // The evidence list follows the month and still holds the full chain: original, correction, void and their reasons.
  await expect(page.getByRole('heading', { name: new RegExp(`รายการหลักฐาน · E2E-TR-T · ${monthLabel(prevMonth)}`) })).toBeVisible();
  await expect(page.locator('article').filter({ hasText: '3.3 °C' })).toContainText('มีการแก้ไขต่อ');
  await expect(page.locator('article').filter({ hasText: '3.4 °C' })).toContainText('แก้ไขจาก');
  await expect(page.locator('article').filter({ hasText: '11.11 °C' })).toContainText('มีการแก้ไขต่อ');
  await expect(page.locator('article').filter({ hasText: 'E2E void chart' })).toContainText('ยกเลิกข้อมูล');
  await expect(page.locator('article').filter({ hasText: '4.5 °C' }), 'this month is not in last month’s evidence').toHaveCount(0);
  // Point details as text (not hover only): the stepper walks points; a click or tap picks the nearest one.
  const detail = tempCard.locator('p[aria-live]');
  await expect(detail).toContainText('จุดล่าสุด:');
  await tempCard.getByRole('button', { name: '‹ จุดก่อนหน้า' }).click();
  await expect(detail).toContainText('บันทึกย้อนหลัง');
  await expect(detail).toContainText('4.00 °C');
  const tempSvg = tempCard.locator('svg[role="img"]');
  const box = (await tempSvg.boundingBox())!;
  await tempSvg.click({ position: { x: 60, y: box.height / 2 } });
  await expect(detail).toContainText('7.50 °C');

  // เลือกเดือน: the month picker; a month with no readings shows an empty state, not an empty chart.
  await periodNav.getByRole('link', { name: 'เลือกเดือน' }).click();
  await expect(page).toHaveURL(new RegExp(`month=${prevMonth}.*#trend-month$`));
  await page.getByLabel('เลือกเดือน', { exact: true }).fill(olderMonth);
  await page.getByRole('button', { name: 'แสดง', exact: true }).click();
  await expect.poll(() => [params().get('range'), params().get('month'), params().get('location')]).toEqual(['month', olderMonth, tempOnly]);
  await expect(periodNav.getByRole('link', { name: 'เลือกเดือน' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('note').filter({ hasText: 'ยังไม่มีข้อมูลสำหรับช่วงเวลาที่เลือก' })).toBeVisible();
  await expect(page.locator('figure.trend-chart svg'), 'no empty chart is drawn').toHaveCount(0);
  // A month in the URL opens that month.
  await page.goto(`/environment/history?warehouse=CHE&location=${tempOnly}&range=month&month=${prevMonth}`);
  await expect(periodNav.getByRole('link', { name: 'เดือนก่อน' })).toHaveAttribute('aria-current', 'true');
  await expect(points).toHaveCount(7);
  // กำหนดเอง: a special review period still works.
  await periodNav.getByRole('link', { name: 'กำหนดเอง' }).click();
  await expect.poll(() => [params().get('range'), params().get('from'), params().get('to')]).toEqual(['custom', `${prevMonth}-01`, `${prevMonth}-${monthDays(prevMonth)}`]);
  await page.getByLabel('ตั้งแต่').fill(`${prevMonth}-01`);
  await page.getByLabel('ถึง').fill(`${prevMonth}-08`);
  await page.getByRole('button', { name: 'แสดง', exact: true }).click();
  await expect.poll(() => [params().get('location'), params().get('range'), params().get('from'), params().get('to'), params().get('metric')]).toEqual([tempOnly, 'custom', `${prevMonth}-01`, `${prevMonth}-08`, 'temperature']);
  await expect(points).toHaveCount(4);
  await expect(bands).toHaveCount(1);
  await expect(bands.first()).toHaveAttribute('data-band-max', '8');
  await expect(tempCard.locator('svg[role="img"]')).toHaveAttribute('data-axis-days', '8');
  await page.goto(`/environment/history?warehouse=CHE&location=${tempOnly}&metric=humidity`);
  await expect(chart('temperature'), 'an unavailable metric falls back to the monitored one').toHaveCount(1);

  // Humidity only.
  await page.goto(`/environment/history?warehouse=CHE&location=${rhOnly}`);
  await expect(metricNav).toHaveCount(0);
  await expect(chart('humidity')).toHaveCount(1);
  await expect(chart('temperature')).toHaveCount(0);
  await expect(chart('humidity').locator('figcaption')).toContainText('Relative humidity (%RH)');
  await expect(chart('humidity').locator('.trend-point')).toHaveCount(1);

  // Both: selector shown, both by default as two separate stacked cards on the same month; then one at a time.
  await page.goto(`/environment/history?warehouse=CHE&location=${both}&range=month&month=${prevMonth}`);
  await expect(metricNav).toBeVisible();
  await expect(metricNav.getByRole('link', { name: 'ทั้งคู่' })).toHaveAttribute('aria-current', 'true');
  await expect(chart('temperature')).toHaveCount(1);
  await expect(chart('humidity')).toHaveCount(1);
  await expect(chart('temperature').locator('polyline'), 'the 4th stands alone; the 10th–12th are connected').toHaveCount(2);
  await expect(chart('humidity').locator('polyline'), 'missing humidity on the 11th splits the line').toHaveCount(2);
  await expect(chart('humidity').locator('svg[role="img"]')).toHaveAttribute('data-axis-days', String(monthDays(prevMonth)));
  const [tempBox, rhBox] = [await chart('temperature').boundingBox(), await chart('humidity').boundingBox()];
  expect(rhBox!.y, 'the two cards are stacked').toBeGreaterThan(tempBox!.y + tempBox!.height - 1);
  expect(Math.abs(rhBox!.width - tempBox!.width), 'the two cards share one width (one time scale)').toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('environment-both-1280.png'), fullPage: true });
  await metricNav.getByRole('link', { name: 'อุณหภูมิ' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`location=${both}&range=month&month=${prevMonth}&metric=temperature`));
  await expect(chart('temperature')).toHaveCount(1);
  await expect(chart('humidity')).toHaveCount(0);
  await metricNav.getByRole('link', { name: 'ความชื้น' }).click();
  await expect(page).toHaveURL(/metric=humidity/);
  await expect(chart('humidity')).toHaveCount(1);
  await expect(chart('temperature')).toHaveCount(0);
  await page.goto(`/environment/history?warehouse=CHE&location=${both}&range=custom&from=${prevMonth}-04&to=${prevMonth}-04`);
  await expect(chart('temperature').locator('.trend-point')).toHaveCount(1);
  await expect(page.locator('figure.trend-empty[data-metric="humidity"]'), 'a humidity-specific empty state, not a broken chart').toContainText('ยังไม่มีค่าความชื้นสัมพัทธ์สำหรับช่วงเวลาที่เลือก');
  await expect(page.locator('figure.trend-empty[data-metric="humidity"] svg')).toHaveCount(0);
  // The location picker offers monitored containers only and works from the keyboard.
  await page.goto(`/environment/history?warehouse=CHE&location=${both}`);
  const picker = page.getByLabel('ตำแหน่งที่เฝ้าระวัง');
  await expect(picker.locator('option', { hasText: 'E2E-TR-T · Synthetic trend fridge' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'E2E-TR-T-S1' }), 'an inherited shelf is not a chart target').toHaveCount(0);
  await picker.focus();
  await picker.selectOption(rhOnly);
  await page.getByRole('button', { name: 'แสดง', exact: true }).press('Enter');
  await expect.poll(() => params().get('location')).toBe(rhOnly);
  await expect(chart('humidity')).toHaveCount(1);

  // An inherited shelf resolves to its monitored parent; nothing is invented for the shelf.
  await page.goto(`/environment/history?warehouse=CHE&location=${shelf}`);
  await expect(page.getByText('E2E-TR-T-S1 อยู่ใน E2E-TR-T · กราฟแสดงข้อมูลของ E2E-TR-T')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'กราฟแนวโน้ม · E2E-TR-T' })).toBeVisible();
  await expect(page.locator('.trend-panel')).toHaveAttribute('data-location', 'E2E-TR-T');
  await expect(chart('temperature').locator('.trend-point')).toHaveCount(1);
  await periodNav.getByRole('link', { name: 'เดือนก่อน' }).click();
  await expect(page, 'links carry the canonical monitored location').toHaveURL(new RegExp(`location=${tempOnly}&range=month&month=${prevMonth}`));

  // Location Detail: compact card for this month, for the monitor, with a link to the full view.
  await page.goto(`/locations/${tempOnly}?warehouse=CHE`);
  await expect(page.getByRole('heading', { name: `แนวโน้มเดือนนี้ · ${monthLabel(thisMonth)}` })).toBeVisible();
  await expect(chart('temperature')).toHaveCount(1);
  await expect(chart('temperature').locator('.trend-point')).toHaveCount(1);
  await expect(chart('temperature').locator('svg[role="img"]')).toHaveAttribute('data-axis-days', String(monthDays(thisMonth)));
  await expect(chart('temperature').locator('.trend-summary')).toContainText('1 จุด');
  await expect(chart('temperature').locator('details'), 'no evidence table on the detail page').toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ดูกราฟและประวัติทั้งหมด' })).toHaveAttribute('href', `/environment/history?warehouse=CHE&location=${tempOnly}&range=month&month=${thisMonth}&metric=temperature`);
  await page.goto(`/locations/${shelf}?warehouse=CHE`);
  await expect(page.getByRole('heading', { name: 'สภาพแวดล้อมของ E2E-TR-T (ตู้/ห้องที่ตำแหน่งนี้อยู่)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `แนวโน้มเดือนนี้ · ${monthLabel(thisMonth)} ของ E2E-TR-T` })).toBeVisible();
  await expect(page.getByText('กราฟนี้เป็นของ E2E-TR-T ซึ่งเป็นตู้/ห้องที่เฝ้าระวังตำแหน่งนี้')).toBeVisible();
  await expect(page.locator('.trend-panel')).toHaveAttribute('data-location', 'E2E-TR-T');
  await expect(page.getByRole('link', { name: 'ดูกราฟและประวัติทั้งหมด' })).toHaveAttribute('href', new RegExp(`location=${tempOnly}&range=month&month=${thisMonth}`));
  await page.goto(`/locations/${both}?warehouse=CHE`);
  await expect(metricNav).toBeVisible();
  await expect(metricNav.getByRole('link', { name: 'ทั้งคู่' })).toHaveAttribute('aria-current', 'true');
  await expect(chart('temperature')).toHaveCount(1);
  await expect(chart('humidity')).toHaveCount(1);
  await metricNav.getByRole('link', { name: 'ความชื้น' }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${both}\\?warehouse=CHE&metric=humidity`));
  await expect(chart('humidity')).toHaveCount(1);
  await expect(chart('temperature')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ดูกราฟและประวัติทั้งหมด' })).toHaveAttribute('href', /metric=humidity/);

  // Responsive and accessibility: no page-level sideways scroll; touch targets; axe clean on phones.
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [`/environment/history?warehouse=CHE&location=${both}&range=month&month=${prevMonth}`, `/environment/history?warehouse=CHE&location=${tempOnly}&range=month&month=${prevMonth}`,
      `/environment/history?warehouse=CHE&location=${tempOnly}`, `/locations/${both}?warehouse=CHE`, `/locations/${shelf}?warehouse=CHE`]) {
      await page.goto(route);
      await expect(page.locator('figure.trend-chart').first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(2);
      const smallTargets = await page.locator('.button, .input, nav[aria-label="เลือกค่าที่แสดงในกราฟ"] a, nav[aria-label="เลือกเดือนหรือช่วงเวลา"] a').evaluateAll(elements => elements
        .map(element => Math.round((element as HTMLElement).getBoundingClientRect().height)).filter(height => height > 0 && height < 44));
      expect(smallTargets, `${route} has undersized touch targets`).toEqual([]);
      if (width === 375) {
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => {
          type AxeApi = { run: (context: Document, options: { runOnly: { type: 'tag'; values: string[] } }) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }> };
          const results = await (window as Window & { axe?: AxeApi }).axe!.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
          return results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }));
        });
        expect(violations, `${route} accessibility violations`).toEqual([]);
      }
    }
    if (width === 375) await page.screenshot({ path: testInfo.outputPath('environment-location-375.png'), fullPage: true });
  }
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

// ---- Post-Phase-3: Environment excursion one-step completion (local disposable data only) --------------------------------
// A fresh out-of-range excursion is created and completed in a single Save, by Staff (not just Supervisor/Admin), with no
// separate acknowledge-then-close stages. A legacy 'acknowledged' excursion (the old two-step flow) is completed without
// its historical corrective action being overwritten. Cross-warehouse and Viewer access remain denied.
test('environment excursion completion: one Staff save resolves it, legacy acknowledged evidence is preserved, cross-warehouse denied', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const baseUrl = process.env.CI_E2E_BASE_URL || 'http://localhost:3100';
  const origin = new URL(baseUrl).origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 500 && response.url().startsWith(origin)) serverErrors.push(`${response.status()} ${response.url()}`); });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password = process.env.CI_E2E_PASSWORD!;
  if (!url || !service || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) throw new Error('Disposable local Supabase required');
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await client.auth.signInWithPassword({ email: 'ephis.e2eadmin@chem-immuno.internal', password })).error).toBeNull();
  const staffClient = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await staffClient.auth.signInWithPassword({ email: 'ephis.e2estaff@chem-immuno.internal', password })).error).toBeNull();

  const range = { temperature_monitored: true, temp_min_c: 2, temp_max_c: 8, humidity_monitored: false, rh_min_pct: null, rh_max_pct: null };
  const fridge = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-EXC-STAFF', name: 'Synthetic completion fridge', location_type: 'refrigerator', env: range } });
  expect(fridge.error).toBeNull();
  const legacyFridge = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-EXC-LEGACY', name: 'Synthetic legacy fridge', location_type: 'refrigerator', env: range } });
  expect(legacyFridge.error).toBeNull();

  async function signInAs(ephisId: string) {
    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Ephis ID' }).fill(ephisId);
    await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  }

  // Staff (not Admin/Supervisor) opens an out-of-range excursion and completes it in one Save.
  await signInAs('e2estaff');
  await page.goto(`/environment/check/${fridge.data}?warehouse=CHE`);
  await page.getByLabel('อุณหภูมิ (°C)').fill('9.5');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByText(/ค่าอยู่นอกช่วง/)).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันบันทึก' }).click();
  await page.getByRole('link', { name: 'ดูเหตุการณ์นอกช่วง' }).click();
  await expect(page.getByRole('heading', { name: /E2E-EXC-STAFF · เหตุการณ์นอกช่วง/ })).toBeVisible();
  await expect(page.getByText('รอดำเนินการ')).toBeVisible();
  await expect(page.getByRole('button', { name: 'รับทราบ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ปิดเหตุการณ์' })).toHaveCount(0);
  const excursionUrl = page.url();
  const excursionId = excursionUrl.split('/').at(-1)!;
  await page.getByLabel('การดำเนินการแก้ไข *').fill('ตรวจตู้และย้ายน้ำยา E2E');
  await page.getByLabel('ผลหลังดำเนินการ *').fill('อุณหภูมิกลับสู่ช่วงปกติแล้ว E2E');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByText('บันทึกการแก้ไขแล้ว')).toBeVisible();
  await expect(page.getByText('ดำเนินการแล้ว')).toBeVisible();
  const resolved = await admin.from('ci_environment_excursions').select('status,immediate_action,resolution_note,resolved_by,resolved_at,acknowledged_by').eq('id', excursionId).single();
  expect(resolved.error).toBeNull();
  expect(resolved.data).toMatchObject({ status: 'resolved', immediate_action: 'ตรวจตู้และย้ายน้ำยา E2E', resolution_note: 'อุณหภูมิกลับสู่ช่วงปกติแล้ว E2E', acknowledged_by: null });
  expect(resolved.data!.resolved_by, 'the actor who saved is recorded as resolved_by').not.toBeNull();
  expect(resolved.data!.resolved_at).not.toBeNull();

  // Attention no longer lists this now-resolved excursion.
  await page.goto('/attention?warehouse=CHE&type=env_excursion');
  await expect(page.locator(`a[href="/environment/excursions/${excursionId}"]`), 'a resolved excursion leaves Attention').toHaveCount(0);

  // A later genuine out-of-range reading on the same location opens a brand NEW excursion; the resolved one is untouched.
  await page.goto(`/environment/check/${fridge.data}?warehouse=CHE`);
  await page.getByLabel('อุณหภูมิ (°C)').fill('9.9');
  await page.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(page.getByText(/ค่าอยู่นอกช่วง/)).toBeVisible();
  await page.getByRole('button', { name: 'ยืนยันบันทึก' }).click();
  await page.getByRole('link', { name: 'ดูเหตุการณ์นอกช่วง' }).click();
  const newExcursionId = page.url().split('/').at(-1)!;
  expect(newExcursionId).not.toBe(excursionId);
  await expect(page.getByText('รอดำเนินการ')).toBeVisible();
  const stillResolved = await admin.from('ci_environment_excursions').select('status,resolution_note').eq('id', excursionId).single();
  expect(stillResolved.data).toMatchObject({ status: 'resolved', resolution_note: 'อุณหภูมิกลับสู่ช่วงปกติแล้ว E2E' });

  // Legacy compatibility: an excursion already 'acknowledged' under the old two-step flow (simulated here by calling the
  // still-present legacy RPC directly) shows its corrective action read-only and asks only for the resolution.
  const legacyReading = await staffClient.rpc('ci_record_environment_reading', { p: { location_id: legacyFridge.data, temperature_c: 9.2, client_request_id: crypto.randomUUID() } });
  expect(legacyReading.error).toBeNull();
  const legacyId = (legacyReading.data as { excursion_id: string }).excursion_id;
  expect(await staffClient.rpc('ci_acknowledge_environment_excursion', { p_id: legacyId, p_immediate_action: 'บันทึกไว้แบบเดิม (สองขั้นตอน) E2E' }).then(r => r.error)).toBeNull();
  await page.goto(`/environment/excursions/${legacyId}`);
  await expect(page.getByText('รับทราบแล้ว')).toBeVisible();
  await expect(page.getByText(/บันทึกไว้ก่อนหน้า.*รับทราบโดย/)).toBeVisible();
  await expect(page.getByLabel('การดำเนินการแก้ไข *'), 'a legacy acknowledged excursion does not re-ask for the corrective action').toHaveCount(0);
  await expect(page.locator('form').getByText('บันทึกไว้แบบเดิม (สองขั้นตอน) E2E'), 'the historical corrective action is shown read-only in the completion form').toBeVisible();
  await page.getByLabel('ผลหลังดำเนินการ *').fill('ปิดงานตามขั้นตอนใหม่ E2E');
  await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
  await expect(page.getByText('ดำเนินการแล้ว')).toBeVisible();
  const legacyResolved = await admin.from('ci_environment_excursions').select('immediate_action,resolution_note,status').eq('id', legacyId).single();
  expect(legacyResolved.data).toMatchObject({ status: 'resolved', immediate_action: 'บันทึกไว้แบบเดิม (สองขั้นตอน) E2E', resolution_note: 'ปิดงานตามขั้นตอนใหม่ E2E' });

  // A Viewer never sees a completion form on any excursion, resolved or open.
  await signInAs('e2eviewer');
  await page.goto(`/environment/excursions/${excursionId}`);
  await expect(page.getByRole('button', { name: 'บันทึกการแก้ไข' })).toHaveCount(0);

  // A Supervisor account scoped only to IMM (warehouse 2) cannot see or reach a CHE excursion: it looks exactly like a
  // missing record, matching the existing cross-warehouse pattern for other Environment resources.
  await signInAs('e2esupervisor');
  await page.goto(`/environment/excursions/${excursionId}`);
  await expect(page.getByRole('heading', { name: 'ไม่พบข้อมูลที่ต้องการ' })).toBeVisible();
  await expect(page.getByText('E2E-EXC-STAFF')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

// ---- Post-Phase-3: Product -> Default Location (local disposable data only) -------------------------------------------------
// The default is only a receiving convenience: it preselects a Location, it is never actual stock truth, a Product may
// still hold stock anywhere, and a warehouse's own Locations never leak into another warehouse's picker.
test('product default location: New Product form, Product Detail, and receiving preselection priority', async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const baseUrl = process.env.CI_E2E_BASE_URL || 'http://localhost:3100';
  const origin = new URL(baseUrl).origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 500 && response.url().startsWith(origin)) serverErrors.push(`${response.status()} ${response.url()}`); });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password = process.env.CI_E2E_PASSWORD!;
  if (!url || !service || !['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) throw new Error('Disposable local Supabase required');
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  expect((await client.auth.signInWithPassword({ email: 'ephis.e2eadmin@chem-immuno.internal', password })).error).toBeNull();

  // Two active CHE Locations (so "several Locations, no default" is genuinely ambiguous). IMM is deliberately left
  // alone here (never adding a second active IMM Location), so whatever the suite's earlier fixtures already set up
  // over there stays "exactly one" - which is exactly the scenario this test needs to prove the pre-existing
  // single-Location auto-select rule still holds after this change.
  const locA = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-PDL-A', name: 'Synthetic PDL location A' } });
  const locB = await client.rpc('ci_create_location_v2', { p: { warehouse_id: 1, code: 'E2E-PDL-B', name: 'Synthetic PDL location B' } });
  expect(locA.error).toBeNull(); expect(locB.error).toBeNull();
  const activeImmLocations = await admin.from('ci_locations').select('id').eq('warehouse_id', 2).eq('active', true);
  expect(activeImmLocations.error).toBeNull();
  expect(activeImmLocations.data, 'this scenario requires exactly one active IMM Location; adjust if suite fixtures change').toHaveLength(1);
  const locImm = { data: activeImmLocations.data![0].id as string };

  const productPayload = (warehouse_id: number, ref: string, extra: Record<string, unknown> = {}) =>
    ({ warehouse_id, product_type: 'reagent', source_name: ref, display_name: ref, current_ref: ref, manufacturer_barcode: `B-${ref}`, ...extra });
  const noDefaultChe = await client.rpc('ci_create_product', { p_data: productPayload(1, 'E2E-PDL-NONE-CHE') });
  const bothDefaultChe = await client.rpc('ci_create_product', { p_data: productPayload(1, 'E2E-PDL-BOTH', { default_location_id: locB.data }) });
  const noDefaultImm = await client.rpc('ci_create_product', { p_data: productPayload(2, 'E2E-PDL-NONE-IMM') });
  expect(noDefaultChe.error).toBeNull(); expect(bothDefaultChe.error).toBeNull(); expect(noDefaultImm.error).toBeNull();
  const scanProductGtin = '00099988877701';
  expect((await admin.from('ci_product_identifiers').insert({ product_id: bothDefaultChe.data, warehouse_id: 1, kind: 'GTIN', value: scanProductGtin, source: 'synthetic_e2e' })).error).toBeNull();
  const bothDefaultCheCode = (await admin.from('ci_products').select('product_code').eq('id', bothDefaultChe.data).single()).data!.product_code as string;

  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2eadmin');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- New Product form: warehouse-scoped picker, resets an incompatible choice on warehouse switch -------------------------
  await page.goto('/products/new?warehouse=CHE');
  const defaultLocationSelect = page.getByLabel('ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)');
  await expect(defaultLocationSelect.getByRole('option', { name: /E2E-PDL-A/ })).toHaveCount(1);
  await expect(defaultLocationSelect.getByRole('option', { name: /E2E-IMM-FR/ }), 'the other warehouse never appears in the picker').toHaveCount(0);
  await defaultLocationSelect.selectOption(locA.data as string);
  await expect(defaultLocationSelect).toHaveValue(locA.data as string);
  const newProductWarehouseSelect = page.locator('form select[name="warehouse_id"]');
  await newProductWarehouseSelect.selectOption('2');
  await expect(defaultLocationSelect, 'switching warehouse clears an incompatible previous choice').toHaveValue('');
  await expect(defaultLocationSelect.getByRole('option', { name: /E2E-IMM-FR/ })).toHaveCount(1);
  await expect(defaultLocationSelect.getByRole('option', { name: /E2E-PDL-A/ }), 'CHE Locations disappear once IMM is chosen').toHaveCount(0);
  await newProductWarehouseSelect.selectOption('1');
  await expect(defaultLocationSelect, 'switching back also resets the selection, never silently keeps an IMM id').toHaveValue('');
  await defaultLocationSelect.selectOption(locA.data as string);
  await page.getByLabel('ชื่อน้ำยาตามแหล่งข้อมูล').fill('E2E-PDL-NEW source');
  await page.getByLabel('ชื่อที่แสดง').fill('E2E-PDL-NEW display');
  await page.getByLabel('REF ปัจจุบัน').fill('E2E-PDL-NEW');
  await page.getByLabel('Manufacturer barcode').fill('B-E2E-PDL-NEW');
  await page.getByRole('button', { name: 'สร้างน้ำยา' }).click();
  await expect(page.getByRole('heading', { name: 'E2E-PDL-NEW display' })).toBeVisible();
  const withDefaultId = new URL(page.url()).pathname.split('/').at(-1)!;
  const created = await admin.from('ci_products').select('default_location_id').eq('id', withDefaultId).single();
  expect(created.data?.default_location_id).toBe(locA.data);

  // --- Product Detail: visible to everyone, editable (change, then clear) only for Admin/Supervisor -------------------------
  await expect(page.getByText('ตำแหน่งจัดเก็บหลัก', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E-PDL-A', { exact: false }).first()).toBeVisible();
  const editSelect = page.getByLabel('ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)');
  await editSelect.selectOption(locB.data as string);
  await page.getByRole('button', { name: 'บันทึกข้อมูลน้ำยา' }).click();
  await expect(page.getByText('บันทึกแล้ว')).toBeVisible();
  expect((await admin.from('ci_products').select('default_location_id').eq('id', withDefaultId).single()).data?.default_location_id).toBe(locB.data);
  await page.getByLabel('ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)').selectOption('');
  await page.getByRole('button', { name: 'บันทึกข้อมูลน้ำยา' }).click();
  await expect(page.getByText('ยังไม่กำหนด')).toBeVisible();
  expect((await admin.from('ci_products').select('default_location_id').eq('id', withDefaultId).single()).data?.default_location_id).toBeNull();
  // Restore a default for the receiving scenarios below.
  await page.getByLabel('ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)').selectOption(locA.data as string);
  await page.getByRole('button', { name: 'บันทึกข้อมูลน้ำยา' }).click();
  await expect(page.getByText('E2E-PDL-A', { exact: false }).first()).toBeVisible();

  // --- Receiving: build one multi-warehouse Invoice covering every priority case at once -----------------------------------
  const vendor = await client.rpc('ci_create_vendor', { p_data: { vendorCode: 'V-E2E-PDL', name: 'Synthetic PDL vendor' } });
  expect(vendor.error).toBeNull();
  const invoice = await client.rpc('ci_create_invoice', { p_data: { vendor_id: vendor.data, invoice_number: 'E2E-PDL-INV-1', invoice_date: '2026-09-24', lines: [
    { product_id: withDefaultId, quantity: 5 }, { product_id: noDefaultChe.data, quantity: 5 }, { product_id: bothDefaultChe.data, quantity: 5 }, { product_id: noDefaultImm.data, quantity: 5 },
  ] } });
  expect(invoice.error).toBeNull();
  await page.goto(`/receive?invoice=${invoice.data}`);
  await expect(page.getByRole('heading', { name: 'ตรวจและรับน้ำยา' })).toBeVisible();
  // The invoice mixes both warehouses; which one the workbench defaults to depends on unspecified row order, so every
  // scenario below selects its own scanning warehouse explicitly rather than assuming a default.
  await page.getByLabel('คลังที่กำลังสแกน').selectOption('1');
  const productSelect = page.getByLabel('Product ใน Invoice');
  const locationSelect = page.getByRole('combobox', { name: 'ตำแหน่ง', exact: true }).first();
  // Each add is one more server round trip (checkLotExpiryConflict); a slightly longer timeout than the default
  // absorbs normal dev-server variance without masking a genuine rejection, which would still fail either way.
  const addPackage = async () => {
    await page.getByRole('button', { name: 'เพิ่มแพ็กเกจในร่าง' }).click();
    await expect(page.getByText(/เพิ่มแพ็กเกจในร่างแล้ว/), 'the package was actually accepted, not silently rejected').toBeVisible({ timeout: 15_000 });
  };

  // A. a valid active default is preselected.
  await productSelect.selectOption((await productSelect.locator('option', { hasText: 'E2E-PDL-NEW' }).first().getAttribute('value')) as string);
  await expect(locationSelect).toHaveValue(locA.data as string);
  // E. the user may still change it away from the default before adding the package.
  await locationSelect.selectOption(locB.data as string);
  await page.getByLabel('LOT').fill('E2E-PDL-LOT-1');
  await page.getByLabel('หมดอายุ').fill('2030-01-01');
  await addPackage();
  const savedRow = page.locator('article').filter({ hasText: 'E2E-PDL-NEW' });
  await expect(savedRow.getByRole('combobox')).toHaveValue(locB.data as string);

  // C. no default, several Locations in this warehouse: blank, the user must choose. (Verified as a preselect value
  // only - not added to the draft - so this scenario cannot interfere with the one package this test actually
  // confirms below; every scenario's preselect is independent of whatever the draft form currently holds.)
  await productSelect.selectOption((await productSelect.locator('option', { hasText: 'E2E-PDL-NONE-CHE' }).first().getAttribute('value')) as string);
  await expect(locationSelect).toHaveValue('');

  // D/G. a Product with its OWN different default is preselected independently of the earlier Product's choice.
  await productSelect.selectOption((await productSelect.locator('option', { hasText: 'E2E-PDL-BOTH' }).first().getAttribute('value')) as string);
  await expect(locationSelect, 'each Product resolves its own default, not the previous package’s manual choice').toHaveValue(locB.data as string);

  // F. a scanned package preselects the Product's own default too.
  await page.getByRole('textbox', { name: /พิมพ์หรือวาง Barcode/ }).fill(`(01)${scanProductGtin}(17)300101(10)E2E-PDL-LOT-SCAN`);
  await page.getByRole('button', { name: 'ตรวจ Barcode' }).click();
  await expect(page.getByText(bothDefaultCheCode).first()).toBeVisible();
  await expect(locationSelect, 'a scanned package preselects the Product’s default the same way a manual pick does').toHaveValue(locB.data as string);

  // B/H. no default, exactly one Location in THIS warehouse: the pre-existing single-Location auto-select still applies,
  // and the CHE Locations never leak into an IMM package's picker (cross-warehouse leakage is impossible).
  await page.getByLabel('คลังที่กำลังสแกน').selectOption('2');
  await productSelect.selectOption((await productSelect.locator('option', { hasText: 'E2E-PDL-NONE-IMM' }).first().getAttribute('value')) as string);
  await expect(locationSelect).toHaveValue(locImm.data as string);
  await expect(locationSelect.getByRole('option', { name: /E2E-PDL-A|E2E-PDL-B/ }), 'no CHE Location is ever offered while scanning IMM').toHaveCount(0);

  // I. the actual confirmed receipt uses the FINAL selected Location (locB for the with-default Product, changed away
  // from its default), never the Product default blindly - proven directly against the ledger.
  const withDefaultLine = await admin.from('ci_invoice_lines').select('id').eq('invoice_id', invoice.data).eq('product_id', withDefaultId).single();
  expect(withDefaultLine.error).toBeNull();
  const idempotencyKey = crypto.randomUUID();
  const confirm = await client.rpc('ci_confirm_receipt_assessed', {
    p_invoice_id: invoice.data, p_idempotency_key: idempotencyKey,
    p_lines: [{ invoice_line_id: withDefaultLine.data!.id, quantity: '5', lot_number: 'E2E-PDL-LOT-1', expiry_date: '2030-01-01', location_id: locB.data }],
    // Matches ci_receipt_assessments' columns (see toAssessmentPayload), not the client-side AssessmentInput shape.
    p_assessment: { correct_product: true, correct_quantity: true, packaging_ok: true, temperature_required: false, temperature_ok: null, shelf_life_ok: null, documentation_complete: true, has_complaint: false, delivery_discrepancy: false, reason_codes: [], other_reason_detail: null, notes: null },
  });
  expect(confirm.error).toBeNull();
  const balances = await admin.from('ci_stock_balances').select('location_id,balance').eq('product_id', withDefaultId);
  expect(balances.error).toBeNull();
  expect(balances.data).toEqual([{ location_id: locB.data, balance: 5 }]);
  const stillDefaultA = await admin.from('ci_products').select('default_location_id').eq('id', withDefaultId).single();
  expect(stillDefaultA.data?.default_location_id, 'confirming a receipt at a different Location never rewrites the Product default').toBe(locA.data);

  // --- Viewer sees the current default read-only, and it survives cross-warehouse RLS the same as any other Product field ---
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('textbox', { name: 'Ephis ID' }).fill('e2eviewer');
  await page.getByRole('textbox', { name: 'รหัสผ่าน' }).fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('heading', { name: /ภาพรวมคลัง/ })).toBeVisible();
  await page.goto(`/products/${withDefaultId}`);
  await expect(page.getByText('ตำแหน่งจัดเก็บหลัก', { exact: true })).toBeVisible();
  await expect(page.getByText('E2E-PDL-A', { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel('ตำแหน่งจัดเก็บหลัก (ค่าเริ่มต้นตอนรับเข้า)'), 'a Viewer sees the value but never an editable control').toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
