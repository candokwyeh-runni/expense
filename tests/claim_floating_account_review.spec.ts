import { expect, test } from '@playwright/test';
import { injectSession, postFormActionDetailed, supabaseAdmin } from './helpers';

const password = 'password123';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProfile(userId: string) {
    for (let i = 0; i < 20; i++) {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('id', userId)
            .maybeSingle();
        if (data?.id) return;
        await sleep(200);
    }
    throw new Error(`Profile not ready for user ${userId}`);
}

async function waitForClaim(
    applicantId: string,
    claimType: string
) {
    for (let i = 0; i < 20; i++) {
        const { data } = await supabaseAdmin
            .from('claims')
            .select('id, bank_code')
            .eq('applicant_id', applicantId)
            .eq('claim_type', claimType)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (data?.id) return data;
        await sleep(200);
    }
    throw new Error(`Claim not ready for applicant ${applicantId}`);
}

function buildItems(amount = 1000) {
    return JSON.stringify([
        {
            date: new Date().toISOString().split('T')[0],
            category: '一般雜支',
            description: 'floating account review item',
            amount,
            attachment_status: 'exempt',
            exempt_reason: '回歸測試'
        }
    ]);
}

test.describe.serial('Claim Floating Account Review', () => {
    let applicant: any;
    let finance: any;
    let payeeId = '';
    let claimId = '';

    test.beforeAll(async () => {
        const ts = Date.now();

        const { data: applicantData, error: applicantError } = await supabaseAdmin.auth.admin.createUser({
            email: `floating_applicant_${ts}@example.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `Floating Applicant ${ts}` }
        });
        if (applicantError || !applicantData?.user) {
            throw applicantError || new Error('Failed to create applicant');
        }
        applicant = applicantData?.user;
        await waitForProfile(applicant.id);

        const { data: financeData, error: financeError } = await supabaseAdmin.auth.admin.createUser({
            email: `floating_finance_${ts}@example.com`,
            password,
            email_confirm: true,
            user_metadata: { full_name: `Floating Finance ${ts}` }
        });
        if (financeError || !financeData?.user) {
            throw financeError || new Error('Failed to create finance reviewer');
        }
        finance = financeData?.user;
        await waitForProfile(finance.id);
        await supabaseAdmin
            .from('profiles')
            .update({ is_finance: true })
            .eq('id', finance.id);

        const { data: payee } = await supabaseAdmin
            .from('payees')
            .insert({
                name: `Floating Vendor ${ts}`,
                type: 'vendor',
                bank: '004',
                bank_account_tail: '3864',
                editable_account: true,
                status: 'available'
            })
            .select('id')
            .single();
        payeeId = payee!.id;
    });

    test.afterAll(async () => {
        if (claimId) {
            await supabaseAdmin.from('claim_items').delete().eq('claim_id', claimId);
            await supabaseAdmin.from('claim_history').delete().eq('claim_id', claimId);
            await supabaseAdmin.from('claims').delete().eq('id', claimId);
        }
        if (payeeId) {
            await supabaseAdmin.from('payees').delete().eq('id', payeeId);
        }
        if (applicant) await supabaseAdmin.auth.admin.deleteUser(applicant.id);
        if (finance) await supabaseAdmin.auth.admin.deleteUser(finance.id);
    });

    test('review page shows claim snapshot instead of payee default bank account', async ({ page }) => {
        await injectSession(page, applicant.email, password);
        await page.goto('/claims/new?type=vendor');

        const createRes = await postFormActionDetailed(page, '/claims/new?/create', {
            claim_type: 'vendor',
            payee_id: payeeId,
            items: buildItems(50400),
            submit_intent: 'submit',
            is_floating_account: 'true',
            bank_code: '007',
            bank_account: '1234554321'
        });

        expect(createRes.status).toBe(200);
        expect(createRes.body).not.toContain('Failed to create claim');

        const createdClaim = await waitForClaim(applicant.id, 'vendor');
        claimId = createdClaim.id;
        expect(createdClaim.bank_code).toBe('007');

        await supabaseAdmin
            .from('claims')
            .update({ status: 'pending_finance' })
            .eq('id', claimId);

        await injectSession(page, finance.email, password);
        await page.goto(`/claims/${claimId}`);

        const bankCodeInput = page.locator('label:has-text("銀行代碼")').locator('..').locator('input');
        const bankAccountInput = page.locator('label:has-text("銀行帳號")').locator('..').locator('input');

        await expect(bankCodeInput).toHaveValue('007');
        await expect(bankAccountInput).toHaveValue('*******54321');
        await expect(bankCodeInput).not.toHaveValue('004');
        await expect(bankAccountInput).not.toHaveValue('*******3864');

        await page.getByTitle('顯示完整帳號').click();
        await expect(bankAccountInput).toHaveValue('1234554321');
    });
});
