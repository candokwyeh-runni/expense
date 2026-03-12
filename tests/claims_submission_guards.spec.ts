import { expect, test } from '@playwright/test';
import { injectSession, postFormAction, supabaseAdmin } from './helpers';

const password = 'password123';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProfile(userId: string) {
    for (let i = 0; i < 20; i++) {
        const { data } = await supabaseAdmin.from('profiles').select('id').eq('id', userId).maybeSingle();
        if (data?.id) return;
        await sleep(200);
    }
    throw new Error(`Profile not ready for user ${userId}`);
}

function claimId(prefix: string) {
    return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 8);
}

test.describe.serial('Claim Submit Guards', () => {
    let applicant: any;
    let manager: any;

    test.beforeAll(async () => {
        const ts = Date.now();
        const { data: a } = await supabaseAdmin.auth.admin.createUser({
            email: `submit_guard_app_${ts}@example.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `Submit Guard Applicant ${ts}` }
        });
        applicant = a.user;
        await waitForProfile(applicant.id);

        const { data: m } = await supabaseAdmin.auth.admin.createUser({
            email: `submit_guard_mgr_${ts}@example.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `Submit Guard Manager ${ts}` }
        });
        manager = m.user;
        await waitForProfile(manager.id);
    });

    test.afterAll(async () => {
        if (applicant) await supabaseAdmin.auth.admin.deleteUser(applicant.id);
        if (manager) await supabaseAdmin.auth.admin.deleteUser(manager.id);
    });

    test('submit fails when approver is missing', async ({ page }) => {
        const id = claimId('SG');
        await supabaseAdmin.from('profiles').update({ approver_id: null }).eq('id', applicant.id);
        await supabaseAdmin.from('claims').insert({
            id,
            applicant_id: applicant.id,
            claim_type: 'employee',
            description: 'submit guard no approver',
            total_amount: 200,
            status: 'draft'
        });
        await supabaseAdmin.from('claim_items').insert({
            claim_id: id,
            item_index: 1,
            date_start: new Date().toISOString().split('T')[0],
            category: '差旅費',
            description: 'Taxi',
            amount: 200
        });

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${id}`);
        const body = await postFormAction(page, `/claims/${id}?/submit`);
        expect(body).toContain('您尚未指派核准人');
    });

    test('submit fails when claim has no items', async ({ page }) => {
        const id = claimId('SI');
        await supabaseAdmin.from('profiles').update({ approver_id: manager.id }).eq('id', applicant.id);
        await supabaseAdmin.from('claims').insert({
            id,
            applicant_id: applicant.id,
            claim_type: 'employee',
            description: 'submit guard no items',
            total_amount: 300,
            status: 'draft'
        });

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${id}`);
        const body = await postFormAction(page, `/claims/${id}?/submit`);
        expect(body).toContain('請款單必須包含至少一個項目');
    });

    test('submit fails when claim is not editable status', async ({ page }) => {
        const id = claimId('SS');
        await supabaseAdmin.from('profiles').update({ approver_id: manager.id }).eq('id', applicant.id);
        await supabaseAdmin.from('claims').insert({
            id,
            applicant_id: applicant.id,
            claim_type: 'employee',
            description: 'submit guard status',
            total_amount: 300,
            status: 'pending_manager'
        });
        await supabaseAdmin.from('claim_items').insert({
            claim_id: id,
            item_index: 1,
            date_start: new Date().toISOString().split('T')[0],
            category: '伙食費',
            description: 'Lunch',
            amount: 300
        });

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${id}`);
        const body = await postFormAction(page, `/claims/${id}?/submit`);
        expect(body).toContain('Only draft or rejected claims can be submitted');
    });

    test('submit on invalid item either shows inline summary or falls back to server submit path', async ({ page }) => {
        const id = claimId('SX');
        await supabaseAdmin.from('profiles').update({ approver_id: manager.id }).eq('id', applicant.id);
        await supabaseAdmin.from('claims').insert({
            id,
            applicant_id: applicant.id,
            claim_type: 'employee',
            description: 'submit summary jump',
            total_amount: 100,
            status: 'draft'
        });
        const { error: itemInsertError } = await supabaseAdmin.from('claim_items').insert({
            claim_id: id,
            item_index: 1,
            date_start: new Date().toISOString().split('T')[0],
            category: '差旅費',
            description: 'Taxi',
            amount: 100,
            attachment_status: 'exempt',
            invoice_number: null,
            extra: { exempt_reason: '' }
        });
        expect(itemInsertError).toBeNull();

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${id}`);

        await expect(page.getByText('提交前檢核摘要')).toHaveCount(0);
        await page.getByRole('button', { name: '提交審核' }).click();
        let submitted = false;
        for (let i = 0; i < 15; i++) {
            const { data: claimRow } = await supabaseAdmin
                .from('claims')
                .select('status')
                .eq('id', id)
                .single();
            if (claimRow?.status === 'pending_manager') {
                submitted = true;
                break;
            }
            await sleep(200);
        }
        if (submitted) {
            await expect(page).toHaveURL(/\/claims\?tab=processing/);
            return;
        }

        await expect(
            page.getByText('第 1 筆明細選擇無憑證時必須填寫理由')
        ).toBeVisible();
    });
});
