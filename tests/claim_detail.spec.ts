/**
 * 請款單詳情頁端對端測試
 *
 * 職責：
 * 1. 驗證請款單詳情頁的基本資訊渲染（類型、描述、狀態、明細項）。
 * 2. 驗證草稿狀態的操作按鈕（提交審核、刪除）。
 * 3. 驗證刪除草稿後重新導向至列表。
 *
 * 測試資料透過 Supabase Admin 直接插入，避免依賴 UI 表單的脆弱性。
 */
import { test, expect } from '@playwright/test';
import { supabaseAdmin, injectSession } from './helpers';

test.describe.serial('Claim Detail Page', () => {
    let testUser: any;
    const password = 'password123';
    let claimId: string;

    async function openClaimDetail(page: any, id: string) {
        await page.goto(`/claims/${id}`);
        if (await page.getByText('費用明細').isVisible()) return;

        await page.goto('/claims?tab=drafts');
        const claimRow = page.locator('tr', {
            has: page.locator(`text=#${id}`)
        }).first();
        await expect(claimRow).toBeVisible();
        await claimRow.click();
        await expect(page).toHaveURL(new RegExp(`/claims/${id}`));
        await expect(page.getByText('費用明細')).toBeVisible();
    }

    async function openFirstItemDialog(page: any) {
        const row = page.getByTestId('claim-item-row-0');
        await expect(row).toBeVisible();
        const openDialog = page.locator('[data-slot="dialog-content"][data-state="open"]').first();

        // E2E 全量並行時偶發第一次點擊未開啟，這裡做一次重試降低 flaky
        for (let attempt = 0; attempt < 2; attempt++) {
            await row.click();
            if (await openDialog.isVisible({ timeout: 2500 }).catch(() => false)) {
                return openDialog;
            }
        }
        await expect(openDialog).toBeVisible();
        return openDialog;
    }

    test.beforeAll(async () => {
        // Create test user
        const email = `claim_detail_${Date.now()}_${Math.floor(Math.random() * 1000)}@runnii.com`;
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { full_name: 'Detail Test User' },
        });
        if (error) throw error;
        testUser = data.user;

        // Create a draft claim directly via DB
        claimId = Math.random().toString(36).substring(2, 10).toUpperCase();
        const { error: claimErr } = await supabaseAdmin
            .from('claims')
            .insert({
                id: claimId,
                claim_type: 'employee',
                description: 'Detail Test Claim',
                applicant_id: testUser.id,
                total_amount: 300,
                status: 'draft',
            });
        if (claimErr) throw claimErr;

        // Create a line item for the claim
        const { error: itemErr } = await supabaseAdmin
            .from('claim_items')
            .insert({
                claim_id: claimId,
                item_index: 1,
                date_start: new Date().toISOString().split('T')[0],
                category: '差旅費',
                description: 'Test line item',
                amount: 300,
            });
        if (itemErr) throw itemErr;
    });

    test.afterAll(async () => {
        // Clean up: delete claim items, claim, and user
        if (claimId) {
            await supabaseAdmin
                .from('claim_items')
                .delete()
                .eq('claim_id', claimId);
            await supabaseAdmin
                .from('claims')
                .delete()
                .eq('id', claimId);
        }
        if (testUser) await supabaseAdmin.auth.admin.deleteUser(testUser.id);
    });

    test('Draft claim opens inline edit mode on detail route', async ({ page }) => {
        await injectSession(page, testUser.email, password);

        await openClaimDetail(page, claimId);
        await expect(page).toHaveURL(new RegExp(`/claims/${claimId}`));

        // Verify unified layout heading
        await expect(page.locator('h1')).toContainText('請款單');

        // Verify expense section exists and can open item drawer
        await expect(page.getByText('費用明細')).toBeVisible();
        await openFirstItemDialog(page);
    });

    test('Draft edit page can submit save action', async ({ page }) => {
        await injectSession(page, testUser.email, password);

        await openClaimDetail(page, claimId);
        const dialog = await openFirstItemDialog(page);
        // 新版 UI 已移除 accordion，欄位直接顯示
        await dialog.getByLabel('說明').fill('Updated from edit page');
        await dialog.getByLabel('發票號碼').fill('AB-12345678');
        await dialog.locator('input[type="file"]').setInputFiles({
            name: 'voucher.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnI7S8AAAAASUVORK5CYII=',
                'base64'
            )
        });
        await dialog.getByRole('button', { name: '儲存明細' }).click();
        // 新版可能「儲存後自動關閉」或「儲存後維持開啟」；兩種都接受。
        if (await dialog.count()) {
            const closeButton = dialog.getByRole('button', { name: 'Close' });
            if (await closeButton.isVisible().catch(() => false)) {
                await closeButton.click();
            } else {
                await page.keyboard.press('Escape');
            }
        }
        await expect(page.locator('[data-slot="dialog-content"][data-state="open"]')).toHaveCount(0);
        await page.getByRole('button', { name: '儲存變更' }).click();
        await expect(page).toHaveURL(new RegExp(`/claims/${claimId}`));
        await expect(page.getByRole('button', { name: '儲存變更' })).toBeVisible();
    });
});
