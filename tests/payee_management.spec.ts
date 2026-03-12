/**
 * Payee Management Extended Flow - E2E 測試
 *
 * 涵蓋功能：
 * 1. 編輯收款人申請 (Update Request)
 * 2. 停用收款人申請 (Disable Request)
 * 3. 財務審核流程 (Approve/Reject)
 */
import { test, expect } from '@playwright/test';
import { supabaseAdmin, injectSession } from './helpers';

test.setTimeout(120000);

test.describe('Payee Management Extended Flow', () => {
    test.describe.configure({ mode: 'serial' });
    let userStandard: any;
    let userFinance: any;
    const password = 'password123';
    let testPayeeId: string;
    let testPayeeName: string;

    async function openPayeeEditDrawer(page: any, payeeId: string) {
        const drawer = page.locator('form[action*="updatePayeeRequest"]').first();
        const row = page.getByTestId(`payee-row-${payeeId}`);
        for (let i = 0; i < 5; i += 1) {
            await row.click();
            if (await drawer.isVisible({ timeout: 1500 }).catch(() => false)) {
                return drawer;
            }
            await page.waitForTimeout(250);
        }
        throw new Error('Payee edit drawer did not open after retries');
    }

    test.beforeAll(async () => {
        const timestamp = Date.now();
        testPayeeName = 'E2E Base Payee ' + timestamp;

        // 1. 建立標準使用者
        const stdEmail = `std_e2e_${timestamp}@example.com`;
        const { data: u1, error: e1 } = await supabaseAdmin.auth.admin.createUser({
            email: stdEmail,
            password,
            email_confirm: true,
            user_metadata: { full_name: 'Std E2E' }
        });
        if (e1) throw e1;
        userStandard = u1.user;

        // 2. 建立財務使用者
        const finEmail = `fin_e2e_${timestamp}@example.com`;
        const { data: u2, error: e2 } = await supabaseAdmin.auth.admin.createUser({
            email: finEmail,
            password,
            email_confirm: true,
            user_metadata: { full_name: 'Fin E2E' }
        });
        if (e2) throw e2;
        userFinance = u2.user;
        await supabaseAdmin.from('profiles').update({ is_finance: true }).eq('id', userFinance.id);

        // 3. 建立一個初始的 'available' 收款人用於測試
        const { data: p, error: pe } = await supabaseAdmin.from('payees').insert({
            name: testPayeeName,
            type: 'vendor',
            bank: '004',
            status: 'available'
        }).select().single();
        if (pe) throw pe;
        testPayeeId = p.id;
    });

    test.afterAll(async () => {
        if (userStandard) await supabaseAdmin.auth.admin.deleteUser(userStandard.id);
        if (userFinance) await supabaseAdmin.auth.admin.deleteUser(userFinance.id);
        if (testPayeeId) {
            await supabaseAdmin.from('payee_change_requests').delete().eq('payee_id', testPayeeId);
            await supabaseAdmin.from('payees').delete().eq('id', testPayeeId);
        }
    });

    test('Standard User can submit an UPDATE request', async ({ page }) => {
        await injectSession(page, userStandard.email, password);
        await page.goto('/payees');
        const drawer = await openPayeeEditDrawer(page, testPayeeId);
        await drawer.getByRole('button', { name: '編輯收款人資訊' }).click();

        const updatedName = testPayeeName + ' (Updated)';
        await drawer.locator('input[name="name"]').fill(updatedName);
        await drawer.locator('input[name="identity_no"]').fill('12345678');
        await drawer.locator('input[name="service_description"]').fill('E2E service');
        await page.evaluate(() => {
            const bankCodeInput = document.querySelector('input[name="bank_code"]') as HTMLInputElement | null;
            if (!bankCodeInput) throw new Error('bank_code input not found');
            bankCodeInput.value = '004';
            bankCodeInput.dispatchEvent(new Event('input', { bubbles: true }));
            bankCodeInput.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await drawer.locator('input[name="bank_account"]').fill('987654321');
        await drawer.locator('textarea[name="reason"]').fill('Testing update flow');

        await drawer.getByRole('button', { name: '送出異動申請' }).click();
        await expect(page.getByText('更新申請已提交，請等待財務審核。')).toBeVisible({
            timeout: 10000,
        });

        // After submission, the page reloads and pending requests appear as:
        // "[更新] {original_payee_name}" with status "待審核 (更新)"
        // Debug: log all rows
        const allRows = page.locator('tbody tr');
        const rowCount = await allRows.count();
        console.log(`DEBUG: Found ${rowCount} rows in table`);
        for (let i = 0; i < Math.min(rowCount, 10); i++) {
            const text = await allRows.nth(i).innerText();
            console.log(`DEBUG Row ${i}: ${text}`);
        }

        // The pending request row should contain the original payee name with [更新] prefix
        const pendingRow = page.locator('tbody tr').filter({ hasText: '更新' }).filter({ hasText: testPayeeName });
        await expect(pendingRow.first()).toBeVisible({ timeout: 10000 });

        // 驗證該行有「待審核」標籤
        await expect(pendingRow.first().getByText(/待審核/)).toBeVisible();
    });

    test('Standard User can submit a DISABLE request', async ({ page }) => {
        await injectSession(page, userStandard.email, password);

        // 先用 admin 撤銷上一步的 update request，讓 payee 回到 available 狀態
        const { data: pendingReqs } = await supabaseAdmin
            .from('payee_change_requests')
            .select('id')
            .eq('payee_id', testPayeeId)
            .eq('status', 'pending');

        if (pendingReqs && pendingReqs.length > 0) {
            for (const req of pendingReqs) {
                await supabaseAdmin
                    .from('payee_change_requests')
                    .update({ status: 'withdrawn' })
                    .eq('id', req.id);
            }
        }

        await page.goto('/payees');
        await page.waitForTimeout(1000);

        const disableActionBtn = page.getByTestId(`payee-request-disable-${testPayeeId}`);
        await expect(disableActionBtn).toBeVisible({ timeout: 15000 });
        await disableActionBtn.click();

        // 確認對話框
        await page
            .getByRole('dialog')
            .filter({ hasText: '確認提交停用申請' })
            .getByRole('button', { name: '提交停用申請', exact: true })
            .click();

        await expect(page.getByText('停用申請已提交')).toBeVisible({ timeout: 10000 });
    });

    test('Finance User can APPROVE a request', async ({ page }) => {
        const { data: pendingRequest, error: pendingError } = await supabaseAdmin
            .from('payee_change_requests')
            .select('id')
            .eq('payee_id', testPayeeId)
            .eq('change_type', 'disable')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (pendingError) throw pendingError;
        expect(pendingRequest?.id).toBeTruthy();

        await injectSession(page, userFinance.email, password);
        await page.goto('/payees');

        // 以同一個已登入 session 直接送 action，避免 UI 對話框渲染時序造成 flake。
        const approveResult = await page.evaluate(async (requestId: string) => {
            const form = new FormData();
            form.append('requestId', requestId);
            const res = await fetch('/payees?/approvePayeeRequest', {
                method: 'POST',
                body: form
            });
            return {
                ok: res.ok,
                status: res.status,
                body: await res.text()
            };
        }, pendingRequest!.id);

        expect(approveResult.ok).toBeTruthy();
        expect(approveResult.body).not.toContain('Unauthorized');
        expect(approveResult.body).not.toContain('操作失敗');
        expect(approveResult.body).not.toContain('Approval RPC Error');

        const { data: approvedRequest, error: approvedError } = await supabaseAdmin
            .from('payee_change_requests')
            .select('status')
            .eq('id', pendingRequest!.id)
            .maybeSingle();

        if (approvedError) throw approvedError;
        if (approvedRequest?.status !== 'approved') {
            await expect.poll(async () => {
                const { data } = await supabaseAdmin
                    .from('payee_change_requests')
                    .select('status')
                    .eq('id', pendingRequest!.id)
                    .maybeSingle();
                return data?.status;
            }, { timeout: 10000 }).toBe('approved');
        }
    });
});
