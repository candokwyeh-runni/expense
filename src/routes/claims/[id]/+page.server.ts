import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { uploadFileToStorage, validateFileUpload } from '$lib/server/storage-upload';
import { checkDuplicateInvoices } from '$lib/server/invoice-check';
import {
    ALLOWED_UPLOAD_MIME_TYPES,
    EDITABLE_CLAIM_STATUSES,
    UPLOADABLE_CLAIM_STATUSES
} from '$lib/server/claims/constants';
import {
    ensureApproverAssigned,
    getOwnedClaim,
    moveClaimToPendingManager,
    parseAndValidateEditForm,
    persistEditedClaim,
    type EditableClaimRow
} from '$lib/server/claims/editing';
import {
    canRejectClaim,
    resolveApproveNextStatus,
    resolveRejectNextStatus,
    resolveReviewerFlags
} from '$lib/server/claims/review-policy';
import { getActiveExpenseCategoryNames, getExpenseCategories } from '$lib/server/expense-categories';
import { triggerNotificationDrain } from '$lib/server/notifications/qstash-trigger';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { env } from '$env/dynamic/private';

async function queueNotificationDrain(origin: string, reason: string): Promise<void> {
    try {
        await triggerNotificationDrain({ origin, reason });
    } catch (drainError) {
        console.error('[notify:qstash] trigger failed:', reason, drainError);
    }
}

function getServiceRoleClient() {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY 未設定');
    }
    return createClient(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

async function requireSession(getSession: () => Promise<any>, message = 'Unauthorized') {
    const session = await getSession();
    if (!session) {
        return { ok: false as const, response: fail(401, { message }) };
    }
    return { ok: true as const, session };
}

function isRequestAbortError(error: unknown): boolean {
    const text = String(
        (error as any)?.message ||
        (error as any)?.cause?.message ||
        error ||
        ''
    ).toLowerCase();
    return text === 'aborted' || text.includes('request aborted');
}

async function readFormDataOrAbort(request: Request) {
    try {
        return { ok: true as const, formData: await request.formData() };
    } catch (error) {
        if (isRequestAbortError(error)) {
            return {
                ok: false as const,
                response: fail(499, { message: 'Request aborted' })
            };
        }
        throw error;
    }
}

async function resolveReviewContext(supabase: any, claimId: string, reviewerId: string) {
    const { data: claim } = await supabase
        .from('claims')
        .select('id, applicant_id, status, applicant:profiles!claims_applicant_id_fkey(approver_id)')
        .eq('id', claimId)
        .single();
    if (!claim) {
        return { ok: false as const, response: fail(404, { message: 'Claim not found' }) };
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('is_finance, is_admin')
        .eq('id', reviewerId)
        .single();

    const reviewer = resolveReviewerFlags(claim, reviewerId, profile);
    return { ok: true as const, claim, reviewer };
}

async function requireOwnedClaim(supabase: any, claimId: string, userId: string) {
    const { data: claim, error: claimError } = await getOwnedClaim(supabase, claimId, userId);
    if (claimError || !claim) {
        return { ok: false as const, response: fail(404, { message: 'Claim not found' }) };
    }
    return { ok: true as const, claim };
}

async function getClaimAccessContext(supabase: any, claimId: string, viewerId: string) {
    const { data: claim } = await supabase
        .from('claims')
        .select('id, applicant_id, status, bank_code, applicant:profiles!claims_applicant_id_fkey(approver_id)')
        .eq('id', claimId)
        .single();
    if (!claim) {
        return { ok: false as const, response: fail(404, { message: 'Claim not found' }) };
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('is_finance, is_admin')
        .eq('id', viewerId)
        .single();

    const applicantObj = Array.isArray(claim.applicant) ? claim.applicant[0] : claim.applicant;
    const isApplicant = claim.applicant_id === viewerId;
    const isApprover = applicantObj?.approver_id === viewerId;
    const isFinance = Boolean(profile?.is_finance);
    const isAdmin = Boolean(profile?.is_admin);
    const canView =
        isApplicant ||
        isFinance ||
        isAdmin ||
        isApprover ||
        claim.status === 'pending_manager';

    if (!canView) {
        return { ok: false as const, response: fail(403, { message: 'Forbidden' }) };
    }

    return { ok: true as const, claim, viewer: { isApplicant, isApprover, isFinance, isAdmin } };
}

async function getClaimBankSnapshot(supabase: any, claimId: string) {
    const { data, error } = await supabase.rpc('get_claim_detail', {
        _claim_id: claimId
    });
    if (error) {
        return { ok: false as const, error };
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
        ok: true as const,
        detail: row
            ? {
                bank_code: String(row.bank_code || '').trim(),
                bank_account: String(row.bank_account || '').trim()
            }
            : null
    };
}

async function deleteClaimCascade(supabase: any, claimId: string) {
    const cleanupResults = await Promise.all([
        supabase.from('notification_logs').delete().eq('claim_id', claimId),
        supabase.from('notification_jobs').delete().eq('claim_id', claimId),
        supabase.from('claim_history').delete().eq('claim_id', claimId),
        supabase.from('claim_items').delete().eq('claim_id', claimId)
    ]);

    const cleanupError = cleanupResults.find((result) => result.error)?.error;
    if (cleanupError) {
        return { ok: false as const, error: cleanupError };
    }

    const { error: deleteError } = await supabase
        .from('claims')
        .delete()
        .eq('id', claimId);
    if (deleteError) {
        return { ok: false as const, error: deleteError };
    }

    return { ok: true as const };
}

async function runEditAction({
    request,
    params,
    supabase,
    session,
    mode
}: {
    request: Request;
    params: { id: string };
    supabase: any;
    session: any;
    mode: 'update' | 'submit';
}) {
    const { data: claimRow, error: claimFetchError } = await supabase
        .from('claims')
        .select('id, applicant_id, claim_type, status, description')
        .eq('id', params.id)
        .eq('applicant_id', session.user.id)
        .single();
    if (claimFetchError || !claimRow) {
        return fail(404, { message: 'Claim not found' });
    }
    if (!EDITABLE_CLAIM_STATUSES.has(claimRow.status)) {
        return fail(400, {
            message: mode === 'submit'
                ? 'Only draft or rejected claims can be submitted'
                : 'Only draft or rejected claims can be edited'
        });
    }

    const formDataResult = await readFormDataOrAbort(request);
    if (!formDataResult.ok) return formDataResult.response;
    const formData = formDataResult.formData;
    const parsed = parseAndValidateEditForm(formData, claimRow as EditableClaimRow, params.id, {
        isDraft: mode === 'update'
    });
    if (!parsed.ok) {
        return fail(parsed.status, { message: parsed.message });
    }

    const activeCategoryNames = await getActiveExpenseCategoryNames(supabase);
    for (let i = 0; i < parsed.value.normalizedItems.length; i += 1) {
        const category = String(parsed.value.normalizedItems[i]?.category || '').trim();
        if (!category || !activeCategoryNames.has(category)) {
            return fail(400, { message: `第 ${i + 1} 筆明細的費用類別無效或已停用` });
        }
    }

    const persist = await persistEditedClaim(supabase, claimRow as EditableClaimRow, parsed.value);
    if (!persist.ok) {
        return fail(persist.status, { message: persist.message });
    }

    if (mode === 'update') {
        throw redirect(303, '/claims');
    }

    const approverCheck = await ensureApproverAssigned(supabase, claimRow.applicant_id);
    if (!approverCheck.ok) {
        return fail(approverCheck.status, { message: approverCheck.message });
    }

    const moveResult = await moveClaimToPendingManager(supabase, params.id, session.user.id);
    if (!moveResult.ok) {
        return fail(moveResult.status, { message: moveResult.message });
    }

    await queueNotificationDrain(new URL(request.url).origin, 'claim.submit');
    throw redirect(303, '/claims?tab=processing');
}

export const load: PageServerLoad = async ({ params, locals: { supabase, getSession } }) => {
    const session = await getSession();
    if (!session) {
        throw redirect(303, '/auth');
    }

    const { id } = params;

    const { data: claim, error: claimError } = await supabase
        .from('claims')
        .select(`
            *,
            payee:payees(id, name, type, bank, bank_account_tail, editable_account),
            applicant:profiles!claims_applicant_id_fkey(id, full_name, approver_id, bank, bank_account_tail),
            items:claim_items(*)
        `)
        .eq('id', id)
        .single();

    if (claimError || !claim) {
        throw error(404, 'Claim not found');
    }

    // RBAC Check for View
    const isApplicant = claim.applicant_id === session.user.id;
    const canEditAsApplicant = isApplicant && EDITABLE_CLAIM_STATUSES.has(claim.status);
    const canSupplementAsApplicant = isApplicant && claim.status === 'paid_pending_doc';

    const { data: profile } = await supabase
        .from('profiles')
        .select('is_finance, is_admin')
        .eq('id', session.user.id)
        .single();

    const isFinance = profile?.is_finance || false;
    const isAdmin = profile?.is_admin || false;

    if (!isApplicant && !isFinance && !isAdmin && claim.status !== 'pending_manager') {
        throw error(403, 'Forbidden');
    }

    // Accurately determine if the user is the designated approver for the applicant
    const applicantObj = Array.isArray(claim.applicant) ? claim.applicant[0] : claim.applicant;
    const isApprover = applicantObj?.approver_id === session.user.id;

    const { data: history } = await supabase
        .from('claim_history')
        .select('*, actor:profiles(full_name)')
        .eq('claim_id', id);

    let duplicateWarnings: any[] = [];
    try {
        duplicateWarnings = await checkDuplicateInvoices(supabase, id);
    } catch (e) {
        console.warn('Duplicate invoice reminder load failed:', e);
    }

    if (claim.items) {
        claim.items.sort((a: any, b: any) => a.item_index - b.item_index);
    }

    const claimBankSnapshot = await getClaimBankSnapshot(supabase, id);
    if (!claimBankSnapshot.ok) {
        console.warn('Claim bank snapshot load failed:', claimBankSnapshot.error);
    }

    const floatingBankCode = claimBankSnapshot.ok
        ? claimBankSnapshot.detail?.bank_code || ''
        : '';
    const floatingBankAccount = claimBankSnapshot.ok
        ? claimBankSnapshot.detail?.bank_account || ''
        : '';

    const sortedHistory = (history || []).sort(
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    let payees: { id: string; name: string; type: string }[] = [];
    if (canEditAsApplicant) {
        const { data: payeesData, error: payeesError } = await supabase
            .from('payees')
            .select('id, name, type, bank, bank_account_tail, editable_account')
            .eq('status', 'available')
            .order('name');
        if (payeesError) {
            console.error('Error fetching payees:', payeesError);
        } else {
            payees = payeesData || [];
        }
    }

    return {
        claim: {
            ...claim,
            bank_code: floatingBankCode || claim.bank_code || '',
            bank_account: floatingBankAccount || '',
            claim_bank_account_tail: floatingBankAccount
                ? floatingBankAccount.slice(-5)
                : '',
            history: sortedHistory
        },
        user: { id: session.user.id, isFinance, isAdmin, isApprover },
        duplicateWarnings,
        payees,
        categoryOptions: await getExpenseCategories(supabase, { activeOnly: true }),
        viewMode: canEditAsApplicant ? 'edit' : canSupplementAsApplicant ? 'supplement' : 'view'
    };

};

export const actions: Actions = {
    revealApplicantAccount: async ({ request, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession, '未登入');
        if (!auth.ok) return auth.response;

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const targetId = String(formData.get('targetId') || '').trim();
        if (!targetId) return fail(400, { message: 'Missing targetId' });

        const { data, error } = await supabase.rpc('reveal_profile_bank_account', {
            target_id: targetId
        });

        if (error) {
            console.error('Reveal Applicant Account Error:', error);
            return fail(500, { message: '解密失敗' });
        }

        return { success: true, decryptedAccount: data };
    },
    revealPayeeAccount: async ({ request, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession, '未登入');
        if (!auth.ok) return auth.response;

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const payeeId = String(formData.get('payeeId') || '').trim();
        if (!payeeId) return fail(400, { message: 'Missing payeeId' });

        const { data, error } = await supabase.rpc('reveal_payee_bank_account', {
            _payee_id: payeeId
        });

        if (error) {
            console.error('Reveal Account Error:', error);
            return fail(500, { message: '解密失敗' });
        }

        return { success: true, decryptedAccount: data };
    },
    revealClaimAccount: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession, '未登入');
        if (!auth.ok) return auth.response;

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const claimId = String(formData.get('claimId') || params.id || '').trim();
        if (!claimId) return fail(400, { message: 'Missing claimId' });

        const access = await getClaimAccessContext(supabase, claimId, auth.session.user.id);
        if (!access.ok) return access.response;
        if (!String(access.claim.bank_code || '').trim()) {
            return fail(400, { message: '此請款單未使用自填帳戶' });
        }

        const detail = await getClaimBankSnapshot(supabase, claimId);
        if (!detail.ok) {
            console.error('Reveal Claim Account Error:', detail.error);
            return fail(500, { message: '解密失敗' });
        }

        return {
            success: true,
            decryptedAccount: detail.detail?.bank_account || ''
        };
    },
    editUpdate: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        return runEditAction({ request, params, supabase, session: auth.session, mode: 'update' });
    },

    editSubmit: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        return runEditAction({ request, params, supabase, session: auth.session, mode: 'submit' });
    },

    update: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (!EDITABLE_CLAIM_STATUSES.has(claim.status)) {
            return fail(400, { message: 'Only draft or rejected claims can be updated' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const description = String(formData.get('description') || '').trim();
        if (!description) {
            return fail(400, { message: 'Description is required' });
        }

        const { error: updateError } = await supabase
            .from('claims')
            .update({ description, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('applicant_id', session.user.id)
            .in('status', Array.from(EDITABLE_CLAIM_STATUSES));

        if (updateError) return fail(500, { message: 'Update failed' });
        return { success: true };
    },

    submit: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;

        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;

        if (!EDITABLE_CLAIM_STATUSES.has(claim.status)) {
            return fail(400, { message: 'Only draft or rejected claims can be submitted' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;

        const approverCheck = await ensureApproverAssigned(supabase, claim.applicant_id);
        if (!approverCheck.ok) {
            return fail(approverCheck.status, { message: approverCheck.message });
        }

        const { count, error: itemCountError } = await supabase
            .from('claim_items')
            .select('id', { head: true, count: 'exact' })
            .eq('claim_id', id);
        if (itemCountError) {
            return fail(500, { message: '讀取請款項目失敗' });
        }

        if (!count || count <= 0) {
            return fail(400, { message: '請款單必須包含至少一個項目' });
        }

        const moveResult = await moveClaimToPendingManager(supabase, id, session.user.id);
        if (!moveResult.ok) {
            return fail(moveResult.status, { message: moveResult.message });
        }
        await queueNotificationDrain(new URL(request.url).origin, 'claim.submit');

        throw redirect(303, '/claims?tab=processing');
    },

    submitSupplement: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (claim.status !== 'paid_pending_doc') {
            return fail(400, { message: 'Only pending supplement claims can be submitted' });
        }

        const { data: items, error: itemsError } = await supabase
            .from('claim_items')
            .select('id, attachment_status, date_start, invoice_number, extra')
            .eq('claim_id', id);

        if (itemsError) return fail(500, { message: '讀取請款項目失敗' });
        if (!items || items.length === 0) {
            return fail(400, { message: '請款單必須包含至少一個項目' });
        }

        for (const item of items) {
            if (item.attachment_status === 'pending_supplement') {
                return fail(400, { message: '仍有明細為「憑證後補」，請完成補件後再送審' });
            }
            if (!item.date_start) {
                return fail(400, { message: '所有明細都必須填寫日期後才能提交補件審核' });
            }
            if (item.attachment_status === 'uploaded') {
                const hasFilePath = Boolean(
                    item?.extra &&
                    typeof (item.extra as Record<string, unknown>).file_path === 'string' &&
                    String((item.extra as Record<string, unknown>).file_path || '').trim().length > 0
                );
                if (!hasFilePath) {
                    return fail(400, { message: '上傳憑證的明細必須附上附件後才能送審' });
                }
                if (!String(item.invoice_number || '').trim()) {
                    return fail(400, { message: '上傳憑證的明細必須填寫發票號碼後才能送審' });
                }
            }
            if (item.attachment_status === 'exempt') {
                const exemptReason = String(
                    ((item.extra as Record<string, unknown> | null)?.exempt_reason as string) || ''
                ).trim();
                if (!exemptReason) {
                    return fail(400, { message: '無憑證的明細必須填寫無憑證理由後才能送審' });
                }
            }
        }

        const { error: updateError } = await supabase
            .from('claims')
            .update({
                status: 'pending_doc_review',
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .eq('applicant_id', session.user.id)
            .eq('status', 'paid_pending_doc');

        if (updateError) return fail(500, { message: '提交補件審核失敗' });
        await queueNotificationDrain(new URL(request.url).origin, 'claim.supplement_submit');

        throw redirect(303, '/claims?tab=processing');
    },

    approve: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const comment = String(formData.get('comment') || '').trim();

        const reviewContext = await resolveReviewContext(supabase, id, session.user.id);
        if (!reviewContext.ok) return reviewContext.response;
        const { claim, reviewer } = reviewContext;
        const nextStatus = resolveApproveNextStatus(claim, reviewer);
        if (!nextStatus) return fail(403, { message: 'Forbidden' });

        const { error: updateError } = await supabase
            .from('claims')
            .update({
                status: nextStatus as any,
                last_comment: comment || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) return fail(500, { message: '核准失敗' });
        await queueNotificationDrain(new URL(request.url).origin, 'claim.approve');
        throw redirect(303, '/approval');
    },

    reject: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const comment = String(formData.get('comment') || '').trim();

        if (!comment) return fail(400, { message: '請提供駁回原因' });

        const reviewContext = await resolveReviewContext(supabase, id, session.user.id);
        if (!reviewContext.ok) return reviewContext.response;
        const { claim, reviewer } = reviewContext;
        if (!canRejectClaim(claim, reviewer)) return fail(403, { message: 'Forbidden' });
        const nextStatus = resolveRejectNextStatus(claim.status);

        const { error: updateError } = await supabase
            .from('claims')
            .update({
                status: nextStatus,
                last_comment: comment,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) return fail(500, { message: '駁回失敗' });
        await queueNotificationDrain(new URL(request.url).origin, 'claim.reject');
        throw redirect(303, '/approval');
    },

    cancel: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (claim.status !== 'rejected') return fail(400, { message: '只有已退件的單據可以撤銷' });

        const { error: updateError } = await supabase
            .from('claims')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', id);

        if (updateError) return fail(500, { message: '撤銷失敗' });
        await queueNotificationDrain(new URL(request.url).origin, 'claim.cancel');
        return { success: true };
    },


    delete: async ({ params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (!EDITABLE_CLAIM_STATUSES.has(claim.status)) {
            return fail(400, { message: 'Only draft or rejected claims can be deleted' });
        }

        const deleteClient = getServiceRoleClient();

        const { data: files } = await deleteClient.storage.from('claims').list(id);
        if (files && files.length > 0) {
            const paths = files.map((f) => `${id}/${f.name}`);
            await deleteClient.storage.from('claims').remove(paths);
        }

        const deleteResult = await deleteClaimCascade(deleteClient, id);
        if (!deleteResult.ok) {
            console.error('Delete claim failed:', deleteResult.error);
            return fail(500, { message: 'Delete failed' });
        }
        throw redirect(303, '/claims');
    },

    upload: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (!UPLOADABLE_CLAIM_STATUSES.has(claim.status)) {
            return fail(400, { message: 'Attachments are not allowed in current claim status' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const file = formData.get('file') as File | null;
        const itemId = String(formData.get('item_id') || '');

        if (!file || !itemId) {
            return fail(400, { message: 'File and Item ID are required' });
        }

        try {
            validateFileUpload(file, '憑證檔案', {
                required: true,
                maxBytes: 10 * 1024 * 1024,
                allowedTypes: ALLOWED_UPLOAD_MIME_TYPES
            });
        } catch (err: any) {
            return fail(400, { message: err.message || 'Unsupported file' });
        }

        const { data: item, error: itemError } = await supabase
            .from('claim_items')
            .select('id, claim_id, extra')
            .eq('id', itemId)
            .eq('claim_id', id)
            .single();

        if (itemError || !item) {
            return fail(404, { message: 'Claim item not found' });
        }

        const currentPath = item.extra?.file_path as string | undefined;
        if (currentPath) {
            await supabase.storage.from('claims').remove([currentPath]);
        }

        let filePath = '';
        try {
            filePath = await uploadFileToStorage(supabase, file, {
                bucket: 'claims',
                prefix: itemId,
                folder: id
            });
        } catch (err: any) {
            console.error('Upload error:', err);
            return fail(500, { message: 'File upload failed' });
        }

        const { error: updateError } = await supabase
            .from('claim_items')
            .update({
                attachment_status: 'uploaded',
                extra: { file_path: filePath, original_name: file.name }
            })
            .eq('id', itemId)
            .eq('claim_id', id);

        if (updateError) {
            console.error('Update item error:', updateError);
            return fail(500, { message: 'Failed to link attachment' });
        }

        return { success: true };
    },

    delete_attachment: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;
        if (!UPLOADABLE_CLAIM_STATUSES.has(claim.status)) {
            return fail(400, { message: 'Attachments are not editable in current claim status' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const itemId = String(formData.get('item_id') || '');
        if (!itemId) return fail(400, { message: 'Item ID is required' });

        const { data: item, error: itemError } = await supabase
            .from('claim_items')
            .select('id, claim_id, extra')
            .eq('id', itemId)
            .eq('claim_id', id)
            .single();

        if (itemError || !item) return fail(404, { message: 'Claim item not found' });

        const dbFilePath = item.extra?.file_path as string | undefined;
        if (dbFilePath) {
            const { error: removeError } = await supabase.storage.from('claims').remove([dbFilePath]);
            if (removeError) {
                console.error('Remove file error:', removeError);
                return fail(500, { message: 'Failed to delete file' });
            }
        }

        const { error: updateError } = await supabase
            .from('claim_items')
            .update({ attachment_status: 'pending_supplement', extra: {} })
            .eq('id', itemId)
            .eq('claim_id', id);

        if (updateError) return fail(500, { message: 'Failed to update attachment status' });

        return { success: true };
    },

    updateItemVoucher: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { data: claim, error: claimError } = await supabase
            .from('claims')
            .select('id, applicant_id, status')
            .eq('id', params.id)
            .single();

        if (claimError || !claim || claim.applicant_id !== session.user.id) {
            return fail(404, { message: 'Claim not found' });
        }

        if (claim.status !== 'paid_pending_doc') {
            return fail(400, { message: 'Only pending supplement claims can update voucher decisions' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const itemId = String(formData.get('item_id') || '').trim();
        const status = String(formData.get('attachment_status') || '').trim();
        const date = String(formData.get('date') || '').trim();
        const invoiceNumber = String(formData.get('invoice_number') || '').trim();
        const exemptReason = String(formData.get('exempt_reason') || '').trim();

        if (!itemId) return fail(400, { message: 'Missing item_id' });
        if (!['uploaded', 'exempt'].includes(status)) {
            return fail(400, { message: '補件階段僅可選擇「上傳憑證」或「無憑證」' });
        }
        if (!date) return fail(400, { message: '日期為必填' });
        if (status === 'uploaded' && !invoiceNumber) {
            return fail(400, { message: '上傳憑證時，發票號碼為必填' });
        }
        if (status === 'exempt' && !exemptReason) {
            return fail(400, { message: '無憑證時，必須填寫理由' });
        }

        const { data: item, error: itemError } = await supabase
            .from('claim_items')
            .select('id, claim_id, extra')
            .eq('id', itemId)
            .eq('claim_id', params.id)
            .single();
        if (itemError || !item) return fail(404, { message: 'Claim item not found' });

        const currentExtra = (item.extra || {}) as Record<string, unknown>;
        const currentPath = typeof currentExtra.file_path === 'string' ? String(currentExtra.file_path) : '';
        const currentOriginalName =
            typeof currentExtra.original_name === 'string' ? String(currentExtra.original_name) : '';

        if (status === 'uploaded' && !currentPath) {
            return fail(400, { message: '上傳憑證時，請先上傳附件檔案' });
        }

        const nextExtra =
            status === 'uploaded'
                ? {
                    file_path: currentPath,
                    original_name: currentOriginalName
                }
                : {
                    exempt_reason: exemptReason
                };

        const { error: updateError } = await supabase
            .from('claim_items')
            .update({
                date_start: date,
                invoice_number: status === 'uploaded' ? invoiceNumber : null,
                attachment_status: status,
                extra: nextExtra
            })
            .eq('id', itemId)
            .eq('claim_id', params.id);

        if (updateError) {
            console.error('Update Item Voucher Error:', updateError);
            return fail(500, { message: '更新憑證決策失敗' });
        }

        return { success: true };
    },

    reviewUpdateItem: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { data: profile } = await supabase
            .from('profiles')
            .select('is_finance')
            .eq('id', session.user.id)
            .single();

        if (!profile?.is_finance) {
            return fail(403, { message: 'Forbidden' });
        }

        const { data: claim, error: claimError } = await supabase
            .from('claims')
            .select('id, status')
            .eq('id', params.id)
            .single();

        if (claimError || !claim) return fail(404, { message: 'Claim not found' });
        if (claim.status !== 'pending_finance') {
            return fail(400, { message: 'Only pending finance claims can be adjusted' });
        }

        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const itemId = String(formData.get('item_id') || '').trim();
        const category = String(formData.get('category') || '').trim();
        const amountRaw = String(formData.get('amount') || '').replaceAll(',', '').trim();
        const amount = Number(amountRaw);

        if (!itemId) return fail(400, { message: 'Missing item_id' });
        const activeCategoryNames = await getActiveExpenseCategoryNames(supabase);
        if (!activeCategoryNames.has(category)) {
            return fail(400, { message: 'Invalid category' });
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            return fail(400, { message: 'Amount must be greater than 0' });
        }

        const { data: item, error: itemError } = await supabase
            .from('claim_items')
            .select('id, claim_id')
            .eq('id', itemId)
            .eq('claim_id', params.id)
            .single();

        if (itemError || !item) return fail(404, { message: 'Claim item not found' });

        const { error: updateItemError } = await supabase
            .from('claim_items')
            .update({
                category,
                amount
            })
            .eq('id', itemId)
            .eq('claim_id', params.id);

        if (updateItemError) {
            console.error('reviewUpdateItem item update error:', updateItemError);
            return fail(500, { message: '更新明細失敗' });
        }

        const { data: claimItems, error: totalFetchError } = await supabase
            .from('claim_items')
            .select('amount')
            .eq('claim_id', params.id);
        if (totalFetchError) {
            console.error('reviewUpdateItem total fetch error:', totalFetchError);
            return fail(500, { message: '重新計算總額失敗' });
        }

        const totalAmount = (claimItems || []).reduce(
            (sum, current) => sum + Number(current.amount || 0),
            0
        );

        const { error: updateClaimError } = await supabase
            .from('claims')
            .update({
                total_amount: totalAmount,
                updated_at: new Date().toISOString()
            })
            .eq('id', params.id)
            .eq('status', 'pending_finance');

        if (updateClaimError) {
            console.error('reviewUpdateItem claim update error:', updateClaimError);
            return fail(500, { message: '更新請款總額失敗' });
        }

        return { success: true };
    },

    withdraw: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;

        const owned = await requireOwnedClaim(supabase, id, session.user.id);
        if (!owned.ok) return owned.response;
        const { claim } = owned;

        if (claim.status !== 'pending_manager' && claim.status !== 'pending_finance') {
            return fail(400, { message: '只有等待審核中的單據可以撤回' });
        }

        const { error: updateError } = await supabase
            .from('claims')
            .update({ status: 'draft', updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('applicant_id', session.user.id)
            .in('status', ['pending_manager', 'pending_finance']);

        if (updateError) return fail(500, { message: 'Withdraw failed' });
        await queueNotificationDrain(new URL(request.url).origin, 'claim.withdraw');
        throw redirect(303, '/claims?tab=drafts');
    },

    togglePayFirst: async ({ request, params, locals: { supabase, getSession } }) => {
        const auth = await requireSession(getSession);
        if (!auth.ok) return auth.response;
        const { session } = auth;

        const { id } = params;
        const formDataResult = await readFormDataOrAbort(request);
        if (!formDataResult.ok) return formDataResult.response;
        const formData = formDataResult.formData;
        const value = formData.get('value') === 'true';

        // Fetch claim to check role
        const { data: claim } = await supabase
            .from('claims')
            .select('applicant_id, status')
            .eq('id', id)
            .single();

        if (!claim) return fail(404, { message: 'Claim not found' });

        const { data: profile } = await supabase
            .from('profiles')
            .select('is_finance, is_admin')
            .eq('id', session.user.id)
            .single();

        const isApplicant = claim.applicant_id === session.user.id;
        const isFinance = profile?.is_finance || profile?.is_admin;

        // Restriction: Only applicant in draft/rejected or Finance can toggle
        const canToggle = (isApplicant && EDITABLE_CLAIM_STATUSES.has(claim.status)) || isFinance;
        if (!canToggle) return fail(403, { message: 'Forbidden' });

        const { error: updateError } = await supabase
            .from('claims')
            .update({ pay_first_patch_doc: value, updated_at: new Date().toISOString() })
            .eq('id', id);

        if (updateError) return fail(500, { message: '更新失敗' });
        return { success: true };
    }
};
