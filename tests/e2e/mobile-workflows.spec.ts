import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

test('local authenticated mobile navigation and warehouse-scoped workflows',async({page,request})=>{
  test.setTimeout(90_000);
  const pageErrors:string[]=[];
  const serverErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('response',response=>{if(response.status()>=500 && response.url().startsWith('http://localhost:3100'))serverErrors.push(`${response.status()} ${response.url()}`);});
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publishable=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const service=process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const password=process.env.CI_E2E_PASSWORD!;
  if(!url||!publishable||!service||!password||!['localhost','127.0.0.1','::1'].includes(new URL(url).hostname))throw new Error('Disposable local Supabase required');
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const email='ephis.e2eadmin@chem-immuno.internal';
  const user=await admin.auth.admin.createUser({email,password,email_confirm:true});
  expect(user.error).toBeNull();
  const bootstrap=await admin.rpc('ci_bootstrap_first_admin',{p_ephis_id:'e2eadmin',p_display_name:'Synthetic E2E Admin'});
  expect(bootstrap.error).toBeNull();
  const client=createClient(url,publishable,{auth:{persistSession:false,autoRefreshToken:false}});
  expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
  let chemProduct='';
  for(const [warehouse_id,source_name,current_ref,manufacturer_barcode] of [[1,'Synthetic CHE one','E2E-C1','E2E-B1'],[1,'Synthetic CHE two','E2E-C2','E2E-B2'],[2,'Synthetic IMM','E2E-I1','E2E-IB1']] as const){
    const created=await client.rpc('ci_create_product',{p_data:{warehouse_id,product_type:'reagent',source_name,current_ref,manufacturer_barcode}});
    expect(created.error).toBeNull();
    if(current_ref==='E2E-C1')chemProduct=created.data as string;
  }
  expect((await admin.from('ci_product_identifiers').insert({product_id:chemProduct,warehouse_id:1,kind:'GTIN',value:'00012345678905',source:'synthetic_e2e'})).error).toBeNull();
  const vendor=await client.rpc('ci_create_vendor',{p_name:'Synthetic E2E Vendor'});
  expect(vendor.error).toBeNull();
  const location=await client.rpc('ci_create_location',{p_warehouse_id:1,p_code:'E2E-A',p_name:'Synthetic shelf'});
  expect(location.error).toBeNull();
  const invoice=await client.rpc('ci_create_invoice',{p_data:{vendor_id:vendor.data,invoice_number:'E2E-INV-1',invoice_date:'2026-09-24',lines:[{product_id:chemProduct,quantity:10}]}});
  expect(invoice.error).toBeNull();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('textbox',{name:'Ephis ID'}).fill('e2eadmin');
  await page.getByLabel('รหัสผ่าน').fill(password);
  await page.getByRole('button',{name:'เข้าสู่ระบบ'}).click();
  await expect(page.getByRole('heading',{name:/ภาพรวมคลัง/})).toBeVisible();
  await expect(page.getByText('Products',{exact:true}).locator('..').getByText('2')).toBeVisible();
  await page.getByRole('link',{name:'IMMUNOLOGY'}).first().click();
  await expect(page).toHaveURL(/warehouse=IMM/);
  await expect(page.getByText('Products',{exact:true}).locator('..').getByText('1')).toBeVisible();
  for(const width of [375,768,1280]){
    await page.setViewportSize({width,height:800});
    for(const route of ['/login','/','/products?warehouse=CHE','/scan','/receive','/attention','/reorder','/reports/monthly?warehouse=CHE','/more']){
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
      expect(overflow,`${route} at ${width}px`).toBeLessThanOrEqual(2);
      if(width===375 && ['/', '/receive', '/reports/monthly?warehouse=CHE'].includes(route)){
        const label=route==='/'?'dashboard':route==='/receive'?'receive':'report';
        await page.screenshot({path:`test-results/${label}-375.png`,fullPage:true});
      }
    }
  }
  await page.setViewportSize({width:375,height:800});
  await page.goto('/');
  await page.getByRole('navigation',{name:'เมนูมือถือ'}).getByRole('link',{name:'Scan'}).click();
  await expect(page).toHaveURL(/\/scan$/);
  await page.goto('/scan');
  await expect(page.getByRole('button',{name:/สแกนอีกครั้ง/})).toBeVisible();
  await expect(page.getByRole('textbox',{name:/พิมพ์หรือวาง Barcode/})).toBeVisible();
  await page.getByRole('textbox',{name:/พิมพ์หรือวาง Barcode/}).fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button',{name:'ตรวจ Barcode'}).click();
  await expect(page.getByText('CHE-0001')).toBeVisible();
  await expect(page.getByText(/^LOT LOT-A/)).toBeVisible();
  await page.goto(`/receive?invoice=${invoice.data}`);
  await expect(page.getByRole('heading',{name:'ตรวจและรับสินค้า'})).toBeVisible();
  await expect(page.getByText('ถ่ายภาพด้วยกล้อง')).toBeVisible();
  await page.getByRole('textbox',{name:/พิมพ์หรือวาง Barcode/}).fill('(01)00012345678905(17)270101(10)LOT-A');
  await page.getByRole('button',{name:'ตรวจ Barcode'}).click();
  await expect(page.getByLabel(/LOT \(จาก Barcode/)).toHaveValue('LOT-A');
  await expect(page.getByLabel(/หมดอายุ \(จาก Barcode/)).toHaveValue('2027-01-01');
  await page.getByRole('combobox',{name:'ตำแหน่ง',exact:true}).selectOption(location.data as string);
  await page.getByRole('button',{name:'เพิ่มแพ็กเกจในร่าง'}).click();
  await expect(page.getByText(/เพิ่มแพ็กเกจในร่างแล้ว/)).toBeVisible();
  await expect(page.getByRole('button',{name:/สแกนอีกครั้ง/})).toBeVisible();
  await expect(page.getByRole('button',{name:/ยืนยันรับเข้า 1 แพ็กเกจ/})).toBeVisible();
  // Leave the draft unconfirmed; local browser acceptance does not create stock.
  const movementCount=await admin.from('ci_stock_transactions').select('id',{count:'exact',head:true});
  expect(movementCount.error).toBeNull();
  expect(movementCount.count).toBe(0);
  await page.getByRole('navigation',{name:'เมนูมือถือ'}).getByRole('link',{name:'More'}).click();
  await expect(page).toHaveURL(/\/more$/);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/reports/monthly?warehouse=CHE&month=2026-09');
  const pdf=await page.pdf({format:'A4',landscape:true,printBackground:true});
  expect(pdf.length).toBeGreaterThan(1000);
  const manifest=await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  expect((await manifest.json()).display).toBe('standalone');
  for(const icon of ['/icon-192.png','/icon-512.png','/apple-touch-icon.png'])expect((await request.get(icon)).ok()).toBeTruthy();
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});
