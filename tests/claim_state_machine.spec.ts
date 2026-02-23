import { expect, test } from '@playwright/test';
import { injectSession, postFormAction, supabaseAdmin } from './helpers';

const password = 'password123';
test.setTimeout(120000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProfile(userId: string) {
    for (let i = 0; i < 20; i++) {
        const { data } = await supabaseAdmin.from('profiles').select('id').eq('id', userId).maybeSingle();
        if (data?.id) return;
        await sleep(200);
    }
    throw new Error(`Profile not ready for user ${userId}`);
}

function cid(prefix: string) {
    return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 8);
}

async function expectStatus(id: string, status: string) {
    for (let i = 0; i < 20; i++) {
        const { data } = await supabaseAdmin.from('claims').select('status').eq('id', id).single();
        if (data?.status === status) return;
        await sleep(200);
    }
    const { data } = await supabaseAdmin.from('claims').select('status').eq('id', id).single();
    expect(data?.status).toBe(status);
}

test.describe.serial('Claim Status Machine', () => {
    let applicant: any;
    let manager: any;
    let finance: any;

    test.beforeAll(async () => {
        const ts = Date.now();
        const { data: a } = await supabaseAdmin.auth.admin.createUser({
            email: `state_app_${ts}@runnii.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `State Applicant ${ts}` }
        });
        applicant = a.user;
        await waitForProfile(applicant.id);

        const { data: m } = await supabaseAdmin.auth.admin.createUser({
            email: `state_mgr_${ts}@runnii.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `State Manager ${ts}` }
        });
        manager = m.user;
        await waitForProfile(manager.id);

        const { data: f } = await supabaseAdmin.auth.admin.createUser({
            email: `state_fin_${ts}@runnii.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `State Finance ${ts}` }
        });
        finance = f.user;
        await waitForProfile(finance.id);
        await supabaseAdmin.from('profiles').update({ is_finance: true }).eq('id', finance.id);
        await supabaseAdmin.from('profiles').update({ approver_id: manager.id }).eq('id', applicant.id);
    });

    test.afterAll(async () => {
        if (applicant) await supabaseAdmin.auth.admin.deleteUser(applicant.id);
        if (manager) await supabaseAdmin.auth.admin.deleteUser(manager.id);
        if (finance) await supabaseAdmin.auth.admin.deleteUser(finance.id);
    });

    test('covers submit/approve/reject/withdraw/cancel transitions', async ({ page }) => {
        const claimFlow = cid('CF');
        const claimReject = cid('CR');
        const claimWithdraw = cid('CW');

        for (const id of [claimFlow, claimReject, claimWithdraw]) {
            await supabaseAdmin.from('claims').insert({
                id,
                applicant_id: applicant.id,
                claim_type: 'employee',
                description: `state machine ${id}`,
                total_amount: 500,
                status: 'draft'
            });
            await supabaseAdmin.from('claim_items').insert({
                claim_id: id,
                item_index: 1,
                date_start: new Date().toISOString().split('T')[0],
                category: '差旅費',
                description: `item ${id}`,
                amount: 500
            });
        }

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${claimFlow}`);
        await postFormAction(page, `/claims/${claimFlow}?/submit`);
        await expectStatus(claimFlow, 'pending_manager');

        await injectSession(page, manager.email, password);
        await page.goto(`/claims/${claimFlow}`);
        await postFormAction(page, `/claims/${claimFlow}?/approve`);
        await expectStatus(claimFlow, 'pending_finance');

        await injectSession(page, finance.email, password);
        await page.goto(`/claims/${claimFlow}`);
        await postFormAction(page, `/claims/${claimFlow}?/approve`);
        await expectStatus(claimFlow, 'pending_payment');

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${claimReject}`);
        await postFormAction(page, `/claims/${claimReject}?/submit`);
        await expectStatus(claimReject, 'pending_manager');

        await injectSession(page, manager.email, password);
        await page.goto(`/claims/${claimReject}`);
        await postFormAction(page, `/claims/${claimReject}?/reject`, { comment: 'need fix' });
        await expectStatus(claimReject, 'rejected');

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${claimReject}`);
        await postFormAction(page, `/claims/${claimReject}?/cancel`);
        await expectStatus(claimReject, 'cancelled');

        await injectSession(page, applicant.email, password);
        await page.goto(`/claims/${claimWithdraw}`);
        await postFormAction(page, `/claims/${claimWithdraw}?/submit`);
        await expectStatus(claimWithdraw, 'pending_manager');
        await postFormAction(page, `/claims/${claimWithdraw}?/withdraw`);
        await expectStatus(claimWithdraw, 'draft');
    });
});
