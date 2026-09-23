import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { signInWithEphisId } from '../../src/lib/ephis-auth';

const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const localUrl = urlValue ? new URL(urlValue) : null;
const canRun = Boolean(localUrl && ['localhost','127.0.0.1','::1'].includes(localUrl.hostname) && publishableKey && serviceRoleKey);

test('real local Supabase Auth maps Ephis IDs, enforces application access, warehouse RLS and role RPCs',
  { skip: !canRun, timeout: 120_000 }, async () => {
    const url = urlValue!;
    const anonKey = publishableKey!;
    const admin = createClient(url, serviceRoleKey!, { auth: { autoRefreshToken: false, persistSession: false } });
    const testPassword = `Local-${crypto.randomUUID()}-A9!`;
    const identities = [
      { ephis: `e2ea${crypto.randomUUID().slice(0,8)}`, name: 'E2E Preview Admin', role: 'admin', warehouses: [1,2], active: true },
      { ephis: `e2es${crypto.randomUUID().slice(0,8)}`, name: 'E2E Chemistry Staff', role: 'staff', warehouses: [1], active: true },
      { ephis: `e2ep${crypto.randomUUID().slice(0,8)}`, name: 'E2E Immunology Supervisor', role: 'supervisor', warehouses: [2], active: true },
      { ephis: `e2ev${crypto.randomUUID().slice(0,8)}`, name: 'E2E Chemistry Viewer', role: 'viewer', warehouses: [1], active: true },
      { ephis: `e2ei${crypto.randomUUID().slice(0,8)}`, name: 'E2E Inactive User', role: 'staff', warehouses: [1], active: false },
    ];
    const authIds: string[] = [];
    const sessions: Array<{ auth: { signOut: (options: { scope: 'local' }) => Promise<unknown> } }> = [];
    const createdProductIds: string[] = [];
    let cleanupTestProducts: (() => Promise<void>) | null = null;

    try {
      const first = identities[0];
      const firstEmail = `ephis.${first.ephis}@chem-immuno.internal`;
      const { data: firstUser, error: createError } = await admin.auth.admin.createUser({ email: firstEmail, password: testPassword, email_confirm: true });
      assert.equal(createError, null, 'local GoTrue must accept the internal Ephis email');
      assert.ok(firstUser.user);
      authIds.push(firstUser.user.id);

      const { error: bootstrapError } = await admin.rpc('ci_bootstrap_first_admin', {
        p_ephis_id: first.ephis, p_display_name: first.name,
      });
      assert.equal(bootstrapError, null);
      const authFactory = () => {
        const values = new Map<string,string>();
        const storage = {
          getItem: async (key: string) => values.get(key) ?? null,
          setItem: async (key: string, value: string) => { values.set(key,value); },
          removeItem: async (key: string) => { values.delete(key); },
        };
        return createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: true, storage } });
      };
      const adminSession = authFactory();
      sessions.push(adminSession);
      cleanupTestProducts = async () => {
        for (const productId of createdProductIds) await adminSession.rpc('ci_delete_product', { p_id: productId });
      };
      const directSession = authFactory();
      sessions.push(directSession);
      const directSignIn = await directSession.auth.signInWithPassword({ email: firstEmail, password: testPassword });
      assert.equal(directSignIn.error, null, `local GoTrue sign-in failed: ${directSignIn.error?.code ?? 'unknown'}`);
      assert.ok(directSignIn.data.session);
      const directProfile = await directSession.from('ci_user_profiles').select('ephis_id,display_name,active').eq('user_id', directSignIn.data.user.id).single();
      assert.equal(directProfile.error, null, `profile query failed: ${directProfile.error?.code ?? 'unknown'}`);
      assert.equal(directProfile.data.ephis_id, first.ephis);
      const directAccess = await directSession.from('ci_user_access').select('warehouse_id,role,active,ci_warehouses(id,code,name)').eq('user_id', directSignIn.data.user.id).eq('active', true);
      assert.equal(directAccess.error, null, `warehouse access query failed: ${directAccess.error?.code ?? 'unknown'}`);
      assert.equal(directAccess.data.length, 2);
      const adminAccess = await signInWithEphisId(adminSession, first.ephis.toUpperCase(), testPassword);
      assert.deepEqual(adminAccess?.warehouses.map(warehouse => warehouse.code).sort(), ['CHE','IMM']);
      assert.equal(adminAccess?.warehouses.every(warehouse => warehouse.role === 'admin'), true);
      const { error: idempotentBootstrapError } = await admin.rpc('ci_bootstrap_first_admin', {
        p_ephis_id: first.ephis, p_display_name: first.name,
      });
      assert.equal(idempotentBootstrapError, null, 'repeating the same initial bootstrap is safe');

      for (const identity of identities.slice(1)) {
        const email = `ephis.${identity.ephis}@chem-immuno.internal`;
        const { data, error } = await admin.auth.admin.createUser({ email, password: testPassword, email_confirm: true });
        assert.equal(error, null);
        assert.ok(data.user);
        authIds.push(data.user.id);
        const { error: provisionError } = await adminSession.rpc('ci_provision_user', {
          p_ephis_id: identity.ephis, p_display_name: identity.name, p_role: identity.role,
          p_warehouse_ids: identity.warehouses, p_active: identity.active,
        });
        assert.equal(provisionError, null);
      }

      assert.equal(await signInWithEphisId(authFactory(), identities[1].ephis, 'incorrect-password'), null);
      assert.equal(await signInWithEphisId(authFactory(), `unknown${crypto.randomUUID().slice(0,8)}`, testPassword), null);
      const staffSession = authFactory();
      sessions.push(staffSession);
      const staffAccess = await signInWithEphisId(staffSession, identities[1].ephis, testPassword);
      assert.deepEqual(staffAccess?.warehouses.map(warehouse => warehouse.code), ['CHE']);
      const supervisorSession = authFactory();
      sessions.push(supervisorSession);
      const supervisorAccess = await signInWithEphisId(supervisorSession, identities[2].ephis, testPassword);
      assert.deepEqual(supervisorAccess?.warehouses.map(warehouse => warehouse.code), ['IMM']);
      const viewerSession = authFactory();
      sessions.push(viewerSession);
      const viewerAccess = await signInWithEphisId(viewerSession, identities[3].ephis, testPassword);
      assert.deepEqual(viewerAccess?.warehouses.map(warehouse => warehouse.code), ['CHE']);

      const chemProduct = await adminSession.rpc('ci_create_product', { p_data: {
        warehouse_id: 1, product_type: 'reagent', source_name: 'Local E2E Chemistry', current_ref: `E2E-C-${crypto.randomUUID()}`,
        manufacturer_barcode: `E2E-C-${crypto.randomUUID()}`,
      } });
      const immProduct = await adminSession.rpc('ci_create_product', { p_data: {
        warehouse_id: 2, product_type: 'reagent', source_name: 'Local E2E Immunology', current_ref: `E2E-I-${crypto.randomUUID()}`,
        manufacturer_barcode: `E2E-I-${crypto.randomUUID()}`,
      } });
      assert.equal(chemProduct.error, null);
      if (chemProduct.data) createdProductIds.push(chemProduct.data);
      assert.equal(immProduct.error, null);
      if (immProduct.data) createdProductIds.push(immProduct.data);

      for (const [session, visibleProduct, hiddenProduct] of [
        [staffSession, chemProduct.data!, immProduct.data!],
        [supervisorSession, immProduct.data!, chemProduct.data!],
      ] as const) {
        const visible = await session.from('ci_products').select('id').eq('id', visibleProduct).single();
        const hidden = await session.from('ci_products').select('id').eq('id', hiddenProduct).maybeSingle();
        assert.equal(visible.error, null);
        assert.equal(hidden.data, null, 'warehouse RLS must hide cross-warehouse products');
      }
      const deniedStaffMutation = await staffSession.rpc('ci_create_product', { p_data: {
        warehouse_id: 1, product_type: 'reagent', source_name: 'Denied staff mutation', current_ref: `E2E-D-${crypto.randomUUID()}`,
        manufacturer_barcode: `E2E-D-${crypto.randomUUID()}`,
      } });
      assert.match(deniedStaffMutation.error?.message ?? '', /CI_ACCESS_DENIED/);
      const deniedViewerMutation = await viewerSession.rpc('ci_create_product', { p_data: {
        warehouse_id: 1, product_type: 'reagent', source_name: 'Denied viewer mutation', current_ref: `E2E-V-${crypto.randomUUID()}`,
        manufacturer_barcode: `E2E-V-${crypto.randomUUID()}`,
      } });
      assert.match(deniedViewerMutation.error?.message ?? '', /CI_ACCESS_DENIED/);
      const supervisorMutation = await supervisorSession.rpc('ci_create_product', { p_data: {
        warehouse_id: 2, product_type: 'reagent', source_name: 'Supervisor permitted mutation', current_ref: `E2E-S-${crypto.randomUUID()}`,
        manufacturer_barcode: `E2E-S-${crypto.randomUUID()}`,
      } });
      assert.equal(supervisorMutation.error, null);
      if (supervisorMutation.data) createdProductIds.push(supervisorMutation.data);

      const inactive = identities[4];
      const inactiveSession = authFactory();
      sessions.push(inactiveSession);
      assert.equal(await signInWithEphisId(inactiveSession, inactive.ephis, testPassword), null);
      assert.equal((await inactiveSession.auth.getSession()).data.session, null, 'inactive user is signed back out');

      const { error: logoutError } = await staffSession.auth.signOut();
      assert.equal(logoutError, null);
      assert.equal((await staffSession.auth.getSession()).data.session, null, 'logout clears the client session');
      const badRefresh = await authFactory().auth.refreshSession({ refresh_token: 'invalid-expired-refresh-token' });
      assert.equal(badRefresh.data.session, null, 'expired/revoked refresh tokens cannot recreate a session');
    } finally {
      if (cleanupTestProducts) await cleanupTestProducts();
      for (const session of sessions) await session.auth.signOut({ scope: 'local' });
      for (const id of authIds) await admin.auth.admin.deleteUser(id);
    }
  });
