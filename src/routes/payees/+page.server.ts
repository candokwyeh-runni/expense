import type { PageServerLoad, Actions } from './$types';
import { error, redirect, fail } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { uploadFileToStorage, validateFileUpload } from '$lib/server/storage-upload';
import { enqueuePayeeRequestNotifications } from '$lib/server/notifications/payee-enqueue';
import { triggerNotificationDrain } from '$lib/server/notifications/qstash-trigger';

const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const PAYEE_SELECT_PRIMARY = 'id, name, type, status, bank, editable_account, unified_no, bank_account, bank_account_tail, service_description, extra_info, attachments, created_at, updated_at';
const PAYEE_SELECT_FALLBACK = 'id, name, type, status, bank, editable_account, bank_account, bank_account_tail, service_description, extra_info, attachments, created_at, updated_at';
const REQUEST_SELECT_PRIMARY = `
            id,
            change_type,
            status,
            proposed_data,
            proposed_unified_no,
            proposed_bank_account,
            proposed_bank_account_tail,
            proposed_attachments,
            reason,
            created_at,
            requested_by,
            payee_id
        `;
const REQUEST_SELECT_FALLBACK = `
            id,
            change_type,
            status,
            proposed_data,
            proposed_bank_account,
            proposed_bank_account_tail,
            proposed_attachments,
            reason,
            created_at,
            requested_by,
            payee_id
        `;
const PAYEE_UPDATE_SELECT_PRIMARY = 'id, name, type, bank, editable_account, unified_no, service_description, extra_info, attachments';
const PAYEE_UPDATE_SELECT_FALLBACK = 'id, name, type, bank, editable_account, service_description, extra_info, attachments';

function normalizeComparable(value: unknown): string {
    if (value == null) return '';
    return String(value).trim();
}

function sanitizeEncryptedPlaceholder(value: unknown): string {
    const text = normalizeComparable(value);
    return text.includes('已加密') ? '' : text;
}

function normalizePayeeIdentity(payee: any): string {
    if (!payee) return '';
    if (payee.type === 'vendor') {
        return normalizeComparable(payee.unified_no);
    }
    return '';
}

function isMissingColumnError(err: any): boolean {
    const text = String(err?.message || '').toLowerCase();
    return err?.code === '42703' || (text.includes('column') && text.includes('does not exist'));
}

function getServiceRoleClient() {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY 未設定');
    }
    return createClient(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

async function queueNotificationDrain(origin: string, reason: string): Promise<void> {
    try {
        await triggerNotificationDrain({ origin, reason });
    } catch (drainError) {
        console.error('[notify:qstash] trigger failed:', reason, drainError);
    }
}

export const load: PageServerLoad = async ({ locals }) => {
    const { supabase, getSession } = locals;
    const session = await getSession();
    if (!session) {
        throw redirect(303, '/auth');
    }

    const isFinance = Boolean(locals.user?.is_finance);
    const serviceRoleClient = getServiceRoleClient();

    const buildPendingRequestsQuery = (selectClause: string) =>
        serviceRoleClient
            .from('payee_change_requests')
            .select(selectClause)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    let pendingRequestsQuery = buildPendingRequestsQuery(REQUEST_SELECT_PRIMARY);
    if (!isFinance) {
        pendingRequestsQuery = pendingRequestsQuery.eq('requested_by', session.user.id);
    }

    // 1. Fetch data in parallel, while keeping compatibility with pre-migration schemas.
    let [payeesResponse, requestsResponse]: any = await Promise.all([
        supabase
            .from('payees')
            .select(PAYEE_SELECT_PRIMARY)
            .order('created_at', { ascending: false }),
        pendingRequestsQuery
    ]);

    if (payeesResponse.error && isMissingColumnError(payeesResponse.error)) {
        payeesResponse = await supabase
            .from('payees')
            .select(PAYEE_SELECT_FALLBACK)
            .order('created_at', { ascending: false });
    }

    if (requestsResponse.error && isMissingColumnError(requestsResponse.error)) {
        let fallbackRequestsQuery = buildPendingRequestsQuery(REQUEST_SELECT_FALLBACK);
        if (!isFinance) {
            fallbackRequestsQuery = fallbackRequestsQuery.eq('requested_by', session.user.id);
        }
        requestsResponse = await fallbackRequestsQuery;
    }

    if (payeesResponse.error) {
        console.error('Error fetching payees:', payeesResponse.error);
        throw error(500, 'Error fetching payees');
    }

    if (requestsResponse.error) {
        console.error('Error fetching pending requests:', requestsResponse.error);
    }

    const payeesWithAttachmentUrls = await Promise.all(
        (payeesResponse.data || []).map(async (payee: any) => {
            const attachments = payee.attachments || {};
            const signedUrls: Record<string, string | null> = {
                id_card_front: null,
                id_card_back: null,
                bank_passbook: null
            };

            const getSignedUrl = async (path?: string) => {
                if (!path) return null;
                const { data } = await serviceRoleClient.storage
                    .from('payees')
                    .createSignedUrl(path, 3600);
                return data?.signedUrl || null;
            };

            if (isFinance && (attachments.id_card_front || attachments.id_card_back || attachments.bank_passbook)) {
                const [front, back, bank] = await Promise.all([
                    getSignedUrl(attachments.id_card_front),
                    getSignedUrl(attachments.id_card_back),
                    getSignedUrl(attachments.bank_passbook)
                ]);

                signedUrls.id_card_front = front;
                signedUrls.id_card_back = back;
                signedUrls.bank_passbook = bank;
            }

            return {
                ...payee,
                identity_no: normalizePayeeIdentity(payee),
                attachment_urls: signedUrls
            };
        })
    );

    const pendingRequests = (requestsResponse.data || []) as any[];
    if (pendingRequests.length > 0) {
        await Promise.all(
            pendingRequests.map(async (req) => {
                const proposedAttachments = req?.proposed_attachments || {};
                req.proposed_attachment_urls = {
                    id_card_front: null,
                    id_card_back: null,
                    bank_passbook: null
                };

                const canViewRequestAttachments =
                    isFinance ||
                    (req?.requested_by === session.user.id && req?.status === 'pending');
                if (
                    canViewRequestAttachments &&
                    (proposedAttachments?.id_card_front ||
                        proposedAttachments?.id_card_back ||
                        proposedAttachments?.bank_passbook)
                ) {
                    const getSignedUrl = async (path?: string) => {
                        if (!path) return null;
                        const { data } = await serviceRoleClient.storage
                            .from('payees')
                            .createSignedUrl(path, 3600);
                        return data?.signedUrl || null;
                    };

                    const [front, back, bank] = await Promise.all([
                        getSignedUrl(proposedAttachments.id_card_front),
                        getSignedUrl(proposedAttachments.id_card_back),
                        getSignedUrl(proposedAttachments.bank_passbook)
                    ]);

                    req.proposed_attachment_urls.id_card_front = front;
                    req.proposed_attachment_urls.id_card_back = back;
                    req.proposed_attachment_urls.bank_passbook = bank;
                }

                if (isFinance && !req?.proposed_data?.identity_no) {
                    try {
                        const { data: proposedTaxId } = await supabase.rpc(
                            'reveal_payee_change_request_tax_id',
                            { _request_id: req.id }
                        );
                        if (proposedTaxId) {
                            req.proposed_data = {
                                ...(req.proposed_data || {}),
                                identity_no: String(proposedTaxId)
                            };
                        }
                    } catch (e) {
                        console.warn('Failed to reveal proposed tax id for request:', req.id);
                    }
                }
                if (!req?.proposed_data?.identity_no && req?.proposed_unified_no) {
                    req.proposed_data = {
                        ...(req.proposed_data || {}),
                        identity_no: String(req.proposed_unified_no)
                    };
                }
                if (isFinance && req?.proposed_bank_account && !req?.proposed_bank_account_plain) {
                    try {
                        const { data: proposedBankAccount } = await supabase.rpc(
                            'reveal_payee_change_request_bank_account',
                            { _request_id: req.id }
                        );
                        if (proposedBankAccount) {
                            req.proposed_bank_account_plain = String(proposedBankAccount);
                        }
                    } catch (e) {
                        console.warn('Failed to reveal proposed bank account for request:', req.id);
                    }
                }

                if (isFinance && req?.payee_id) {
                    try {
                        const { data: linkedTaxId } = await supabase.rpc(
                            'reveal_payee_tax_id',
                            { _payee_id: req.payee_id }
                        );
                        if (linkedTaxId) {
                            req.linked_identity_no = String(linkedTaxId);
                        }
                    } catch (e) {
                        console.warn('Failed to reveal linked payee tax id for request:', req.id);
                    }
                    try {
                        const { data: linkedBankAccount } = await supabase.rpc(
                            'reveal_payee_bank_account',
                            { _payee_id: req.payee_id }
                        );
                        if (linkedBankAccount) {
                            req.linked_bank_account_plain = String(linkedBankAccount);
                        }
                    } catch (e) {
                        console.warn('Failed to reveal linked payee bank account for request:', req.id);
                    }
                }
            })
        );
    }

    return {
        payees: payeesWithAttachmentUrls,
        pendingRequests,
        user: session.user,
        is_finance: locals.user?.is_finance ?? false,
        is_admin: locals.user?.is_admin ?? false
    };
};

export const actions: Actions = {
    /**
     * 更新收款人資料申請
     */
    updatePayeeRequest: async ({ request, locals: { supabase, getSession } }) => {
        const session = await getSession();
        if (!session) {
            return fail(401, { message: 'Unauthorized' });
        }

        const formData = await request.formData();
        const payeeId = formData.get('id') as string;

        if (!payeeId) {
            return fail(400, { message: '缺少收款人 ID' });
        }

        // Extract fields
        const type = (formData.get('type') as string || '').trim();
        const name = (formData.get('name') as string || '').trim();
        const rawIdentity = (
            (formData.get('identity_no') as string) || ''
        ).trim();
        const identity_no = sanitizeEncryptedPlaceholder(rawIdentity);
        const rawBankAccount = (formData.get('bank_account') as string || '').trim();
        const bank_account = sanitizeEncryptedPlaceholder(rawBankAccount);
        const bank_code = (formData.get('bank_code') as string || '').trim();
        const editable_account = String(formData.get('editable_account') || '').trim() === 'true';
        const email = (formData.get('email') as string || '').trim();
        const address = (formData.get('address') as string || '').trim();
        const service_description = (formData.get('service_description') as string || '').trim();
        const reason = (formData.get('reason') as string || '').trim() || '資料更新申請';
        const removeIdFront = (formData.get('remove_attachment_id_front') as string) === 'true';
        const removeIdBack = (formData.get('remove_attachment_id_back') as string) === 'true';
        const removeBankCover = (formData.get('remove_attachment_bank_cover') as string) === 'true';

        // 先讀目前正式資料，用於 diff 判斷（reason 不計入）
        const { data: currentPayee, error: currentPayeeError } = await supabase
            .from('payees')
            .select(PAYEE_UPDATE_SELECT_PRIMARY)
            .eq('id', payeeId)
            .single();

        let resolvedCurrentPayee = currentPayee as any;
        let resolvedCurrentPayeeError = currentPayeeError;
        if (resolvedCurrentPayeeError && isMissingColumnError(resolvedCurrentPayeeError)) {
            const fallbackCurrentPayee = await supabase
                .from('payees')
                .select(PAYEE_UPDATE_SELECT_FALLBACK)
                .eq('id', payeeId)
                .single();
            resolvedCurrentPayee = fallbackCurrentPayee.data as any;
            resolvedCurrentPayeeError = fallbackCurrentPayee.error;
        }

        if (resolvedCurrentPayeeError || !resolvedCurrentPayee) {
            return fail(404, { message: '找不到收款人資料' });
        }

        // --- Basic Validation ---
        if (!name) return fail(400, { message: '收款人名稱為必填' });
        if (!service_description) return fail(400, { message: '服務項目說明為必填' });
        if (!bank_code) return fail(400, { message: '銀行代碼為必填' });
        if (!bank_account) return fail(400, { message: '銀行帳號為必填' });
        if (!identity_no) {
            return fail(
                400,
                { message: type === 'vendor' ? '統一編號為必填' : '身分證字號為必填' }
            );
        }
        if (type === 'personal' && !email) return fail(400, { message: '電子郵件為必填' });
        if (type === 'personal' && !address) return fail(400, { message: '戶籍/通訊地址為必填' });

        if (type === 'vendor' && !/^\d{8}$/.test(identity_no)) {
            return fail(400, { message: '統一編號格式不正確：須為 8 碼數字' });
        }
        if (type === 'personal' && !/^[A-Z][0-9]{9}$/.test(identity_no)) {
            return fail(400, { message: '身分證字號格式不正確：須為「1 碼大寫英文字母」+「9 碼數字」' });
        }
        // --- Handle Attachments for Personal Payees ---
        let attachments: Record<string, any> = {};
        let attachmentsChanged = false;

        if (type === 'personal') {
            const currentAttachments = resolvedCurrentPayee?.attachments || {};

            const files = {
                id_front: formData.get('attachment_id_front') as File,
                id_back: formData.get('attachment_id_back') as File,
                bank_cover: formData.get('attachment_bank_cover') as File
            };

            const attachmentIntentChanged =
                Boolean(files.id_front && files.id_front.size > 0) ||
                Boolean(files.id_back && files.id_back.size > 0) ||
                Boolean(files.bank_cover && files.bank_cover.size > 0) ||
                removeIdFront ||
                removeIdBack ||
                removeBankCover;

            if (attachmentIntentChanged) {
                try {
                    if (files.id_front && files.id_front.size > 0) {
                        validateFileUpload(files.id_front, '身分證正面', {
                            maxBytes: MAX_ATTACHMENT_SIZE_BYTES,
                            allowedTypes: ALLOWED_ATTACHMENT_TYPES
                        });
                    }
                    if (files.id_back && files.id_back.size > 0) {
                        validateFileUpload(files.id_back, '身分證反面', {
                            maxBytes: MAX_ATTACHMENT_SIZE_BYTES,
                            allowedTypes: ALLOWED_ATTACHMENT_TYPES
                        });
                    }
                    if (files.bank_cover && files.bank_cover.size > 0) {
                        validateFileUpload(files.bank_cover, '存摺封面', {
                            maxBytes: MAX_ATTACHMENT_SIZE_BYTES,
                            allowedTypes: ALLOWED_ATTACHMENT_TYPES
                        });
                    }
                } catch (err: any) {
                    return fail(400, { message: err.message || '附件驗證失敗' });
                }

                try {
                    // Determine new paths: use new upload if present, else use existing
                    const newPaths = {
                        id_card_front: (files.id_front && files.id_front.size > 0)
                            ? await uploadFileToStorage(supabase, files.id_front, { bucket: 'payees', prefix: 'id_front' })
                            : removeIdFront
                                ? null
                            : currentAttachments.id_card_front,
                        id_card_back: (files.id_back && files.id_back.size > 0)
                            ? await uploadFileToStorage(supabase, files.id_back, { bucket: 'payees', prefix: 'id_back' })
                            : removeIdBack
                                ? null
                            : currentAttachments.id_card_back,
                        bank_passbook: (files.bank_cover && files.bank_cover.size > 0)
                            ? await uploadFileToStorage(supabase, files.bank_cover, { bucket: 'payees', prefix: 'bank_cover' })
                            : removeBankCover
                                ? null
                            : currentAttachments.bank_passbook
                    };

                    // Validate that we have all required attachments (either new or existing)
                    if (!newPaths.id_card_front) return fail(400, { message: '身分證正面附件為必填' });
                    if (!newPaths.id_card_back) return fail(400, { message: '身分證反面附件為必填' });
                    if (!newPaths.bank_passbook) return fail(400, { message: '存摺封面附件為必填' });

                    attachmentsChanged =
                        normalizeComparable(newPaths.id_card_front) !== normalizeComparable(currentAttachments.id_card_front) ||
                        normalizeComparable(newPaths.id_card_back) !== normalizeComparable(currentAttachments.id_card_back) ||
                        normalizeComparable(newPaths.bank_passbook) !== normalizeComparable(currentAttachments.bank_passbook);

                    if (attachmentsChanged) {
                        attachments = newPaths;
                    }
                } catch (err: any) {
                    console.error('File Upload Error:', err);
                    return fail(500, { message: '檔案上傳失敗：' + (err.message || '未知錯誤') });
                }
            }
        }
        const currentExtra = resolvedCurrentPayee.extra_info || {};
        const proposed_data: Record<string, string> = {};

        if (normalizeComparable(name) !== normalizeComparable(resolvedCurrentPayee.name)) {
            proposed_data.name = name;
        }
        if (normalizeComparable(type) !== normalizeComparable(resolvedCurrentPayee.type)) {
            proposed_data.type = type;
        }
        if (normalizeComparable(bank_code) !== normalizeComparable(resolvedCurrentPayee.bank)) {
            proposed_data.bank_code = bank_code;
        }
        if (normalizeComparable(service_description) !== normalizeComparable(resolvedCurrentPayee.service_description)) {
            proposed_data.service_description = service_description;
        }
        if (type === 'vendor') {
            if (Boolean(editable_account) !== Boolean(resolvedCurrentPayee.editable_account)) {
                proposed_data.editable_account = editable_account ? 'true' : 'false';
            }
        } else if (Boolean(resolvedCurrentPayee.editable_account)) {
            proposed_data.editable_account = 'false';
        }
        if (type === 'personal') {
            if (normalizeComparable(email) !== normalizeComparable(currentExtra.email)) {
                proposed_data.email = email;
            }
            if (normalizeComparable(address) !== normalizeComparable(currentExtra.address)) {
                proposed_data.address = address;
            }
        }

        let identityChanged = false;
        if (identity_no) {
            let currentIdentity = '';
            if (type === 'vendor') {
                currentIdentity = sanitizeEncryptedPlaceholder(
                    resolvedCurrentPayee.unified_no
                );
            } else {
                const { data: revealedTaxId } = await supabase.rpc('reveal_payee_tax_id', {
                    _payee_id: payeeId
                });
                currentIdentity = sanitizeEncryptedPlaceholder(revealedTaxId);
            }
            identityChanged = normalizeComparable(identity_no) !== normalizeComparable(currentIdentity);
        }

        let bankAccountChanged = false;
        if (bank_account) {
            let currentBankAccount = '';
            const { data: revealedBank } = await supabase.rpc('reveal_payee_bank_account', {
                _payee_id: payeeId
            });
            currentBankAccount = normalizeComparable(revealedBank);
            bankAccountChanged = normalizeComparable(bank_account) !== currentBankAccount;
        }

        const hasChanges =
            Object.keys(proposed_data).length > 0 ||
            identityChanged ||
            bankAccountChanged ||
            attachmentsChanged;

        if (!hasChanges) {
            return fail(400, { message: '至少需修改一項資料後才能提交異動申請' });
        }

        const { data: requestId, error: rpcError } = await supabase.rpc('submit_payee_change_request', {
            _change_type: 'update',
            _payee_id: payeeId,
            _proposed_data: proposed_data,
            _proposed_tax_id: identityChanged ? identity_no : null,
            _proposed_bank_account: bankAccountChanged ? bank_account : null,
            _reason: reason,
            _proposed_attachments: attachments
        });

        if (rpcError) {
            console.error('Update Request Error:', rpcError);
            return fail(500, { message: '提交更新申請失敗：' + rpcError.message });
        }

        try {
            if (requestId) {
                await enqueuePayeeRequestNotifications({
                    eventCode: 'payee_update_submitted',
                    requestId: String(requestId),
                    actorId: session.user.id,
                    reason
                });
                await queueNotificationDrain(new URL(request.url).origin, 'payee.update.submit');
            }
        } catch (notifyError) {
            console.error('[notify:payee] update request enqueue failed', notifyError);
        }

        return { success: true, message: '更新申請已提交' };
    },

    /**
     * 解密收款人銀行帳號 (所有已登入使用者可查看)
     */
    revealPayeeAccount: async ({ request, locals: { supabase, getSession, user } }) => {
        const session = await getSession();
        if (!session) return fail(401, { message: '未登入' });
        if (!user?.is_finance) return fail(403, { message: '權限不足：僅財務可檢視完整帳號' });

        const formData = await request.formData();
        const payeeId = formData.get('payeeId') as string;

        if (!payeeId) return fail(400, { message: '收款人 ID 為必填' });

        const { data, error } = await supabase.rpc('reveal_payee_bank_account', {
            _payee_id: payeeId
        });

        if (error) {
            console.error('Reveal Account Error:', error);
            return fail(500, { message: '解密失敗' });
        }

        return { success: true, decryptedAccount: data };
    },
    revealPayeeTaxId: async ({ request, locals: { supabase, getSession, user } }) => {
        const session = await getSession();
        if (!session) return fail(401, { message: '未登入' });
        if (!user?.is_finance) return fail(403, { message: '權限不足：僅財務可檢視完整身分證字號' });

        const formData = await request.formData();
        const payeeId = formData.get('payeeId') as string;
        if (!payeeId) return fail(400, { message: '收款人 ID 為必填' });

        const { data, error } = await supabase.rpc('reveal_payee_tax_id', {
            _payee_id: payeeId
        });

        if (error) {
            console.error('Reveal Tax ID Error:', error);
            return fail(500, { message: '讀取統編失敗' });
        }

        return { success: true, taxId: data };
    },
    /**
     * 核准收款人申請 (僅財務權限)
     */
    approvePayeeRequest: async ({ request, locals: { supabase, getSession, user } }) => {
        const session = await getSession();
        if (!session || !user?.is_finance) {
            return fail(403, { message: '權限不足：僅財務人員可核准申請' });
        }

        const formData = await request.formData();
        const requestId = formData.get('requestId') as string;

        if (!requestId) return fail(400, { message: '缺少申請 ID' });

        const { error: rpcError } = await supabase.rpc('approve_payee_change_request', {
            _request_id: requestId
        });

        if (rpcError) {
            console.error('Approval RPC Error:', rpcError);
            return fail(500, { message: '核准失敗：' + rpcError.message });
        }

        try {
            await enqueuePayeeRequestNotifications({
                eventCode: 'payee_request_approved',
                requestId,
                actorId: session.user.id
            });
            await queueNotificationDrain(new URL(request.url).origin, 'payee.request.approve');
        } catch (notifyError) {
            console.error('[notify:payee] approve enqueue failed', notifyError);
        }

        return { success: true, message: '申請已核准' };
    },

    /**
     * 駁回收款人申請 (僅財務權限)
     */
    rejectPayeeRequest: async ({ request, locals: { supabase, getSession, user } }) => {
        const session = await getSession();
        if (!session || !user?.is_finance) {
            return fail(403, { message: '權限不足：僅財務人員可駁回申請' });
        }

        const formData = await request.formData();
        const requestId = formData.get('requestId') as string;

        if (!requestId) return fail(400, { message: '缺少申請 ID' });

        const { error: rpcError } = await supabase.rpc('reject_payee_change_request', {
            _request_id: requestId
        });

        if (rpcError) {
            console.error('Rejection RPC Error:', rpcError);
            return fail(500, { message: '駁回失敗：' + rpcError.message });
        }

        try {
            await enqueuePayeeRequestNotifications({
                eventCode: 'payee_request_rejected',
                requestId,
                actorId: session.user.id
            });
            await queueNotificationDrain(new URL(request.url).origin, 'payee.request.reject');
        } catch (notifyError) {
            console.error('[notify:payee] reject enqueue failed', notifyError);
        }

        return { success: true, message: '申請已駁回' };
    },

    /**
     * 撤銷收款人新增申請
     * 僅允許申請人撤銷自己的 pending 申請
     */
    withdrawRequest: async ({ request, locals: { supabase, getSession } }) => {
        const session = await getSession();
        if (!session) return fail(401, { message: '未登入' });

        const formData = await request.formData();
        const requestId = formData.get('requestId') as string;

        if (!requestId) return fail(400, { message: '缺少申請 ID' });

        // 驗證申請存在且為 pending 狀態，且為申請人本人
        const { data: changeRequest, error: fetchError } = await supabase
            .from('payee_change_requests')
            .select('id, status, requested_by')
            .eq('id', requestId)
            .single();

        if (fetchError || !changeRequest) {
            return fail(404, { message: '找不到此申請' });
        }

        if (changeRequest.status !== 'pending') {
            return fail(400, { message: '僅能撤銷待審核的申請' });
        }

        if (changeRequest.requested_by !== session.user.id) {
            return fail(403, { message: '僅能撤銷自己的申請' });
        }

        // 更新狀態為 withdrawn
        const { error: updateError } = await supabase
            .from('payee_change_requests')
            .update({ status: 'withdrawn' })
            .eq('id', requestId);

        if (updateError) {
            return fail(500, { message: '撤銷失敗', error: updateError.message });
        }

        try {
            await enqueuePayeeRequestNotifications({
                eventCode: 'payee_request_withdrawn',
                requestId,
                actorId: session.user.id
            });
            await queueNotificationDrain(new URL(request.url).origin, 'payee.request.withdraw');
        } catch (notifyError) {
            console.error('[notify:payee] withdraw enqueue failed', notifyError);
        }

        return { success: true, message: '申請已撤銷' };
    },

    /**
     * 提交停用收款人申請
     */
    submitDisableRequest: async ({ request, locals: { supabase, getSession } }) => {
        const session = await getSession();
        if (!session) return fail(401, { message: '未登入' });

        const formData = await request.formData();
        const payeeId = formData.get('payeeId') as string;
        const reason = formData.get('reason') as string || '停用收款人申請';


        if (!payeeId) return fail(400, { message: '缺少收款人 ID' });

        const { data: requestId, error: rpcError } = await supabase.rpc('submit_payee_change_request', {
            _change_type: 'disable',
            _payee_id: payeeId,
            _proposed_data: {},
            _proposed_tax_id: null,
            _proposed_bank_account: null,
            _reason: reason
        });

        if (rpcError) {
            console.error('Disable Request Error:', rpcError);
            return fail(500, { message: '提交停用申請失敗：' + rpcError.message });
        }

        try {
            if (requestId) {
                await enqueuePayeeRequestNotifications({
                    eventCode: 'payee_disable_submitted',
                    requestId: String(requestId),
                    actorId: session.user.id,
                    reason
                });
                await queueNotificationDrain(new URL(request.url).origin, 'payee.disable.submit');
            }
        } catch (notifyError) {
            console.error('[notify:payee] disable enqueue failed', notifyError);
        }

        return { success: true, message: '停用申請已提交，請等待財務審核' };
    },

    /**
     * 永久刪除收款人 (僅財務權限)
     * 並處理資料庫 FK 限制驗證
     */
    removePayee: async ({ request, locals: { getSession, user } }) => {
        const session = await getSession();
        if (!session || !user?.is_finance) {
            return fail(403, { message: '權限不足：僅財務可執行此操作' });
        }

        const formData = await request.formData();
        const payeeId = formData.get('payeeId') as string;

        if (!payeeId) return fail(400, { message: '缺少收款人 ID' });

        let serviceRoleClient;
        try {
            serviceRoleClient = getServiceRoleClient();
        } catch (e: any) {
            return fail(500, { message: `刪除失敗：${e?.message || '缺少 Service Role 設定'}` });
        }

        const { error: deleteError } = await serviceRoleClient
            .from('payees')
            .delete()
            .eq('id', payeeId);

        if (deleteError) {
            // FK 衝突是預期行為：有關聯資料時禁止永久刪除，降低為 warn 避免誤報
            if (deleteError.code === '23503') {
                console.warn('Delete Payee Blocked (expected_fk_conflict):', {
                    code: deleteError.code,
                    message: deleteError.message,
                    details: deleteError.details
                });
                return fail(400, {
                    message: '無法刪除：此收款人已有關聯之報銷案件或申請記錄。請改成「停用」處理。'
                });
            }
            console.error('Delete Payee Error:', deleteError);
            return fail(500, { message: '刪除失敗：' + deleteError.message });
        }

        return { success: true, message: '收款人已永久刪除' };
    },

    /**
     * 直接切換收款人狀態 (僅財務權限)
     */
    toggleStatus: async ({ request, locals: { getSession, user } }) => {
        const session = await getSession();
        if (!session || !user?.is_finance) {
            return fail(403, { message: '權限不足：僅財務可執行此操作' });
        }

        const formData = await request.formData();
        const payeeId = formData.get('payeeId') as string;
        const currentStatus = formData.get('currentStatus') as string;

        if (!payeeId) return fail(400, { message: '缺少收款人 ID' });

        const newStatus = currentStatus === 'available' ? 'disabled' : 'available';

        let serviceRoleClient;
        try {
            serviceRoleClient = getServiceRoleClient();
        } catch (e: any) {
            return fail(500, { message: `更新狀態失敗：${e?.message || '缺少 Service Role 設定'}` });
        }

        const { data: updatedRows, error: updateError } = await serviceRoleClient
            .from('payees')
            .update({ status: newStatus })
            .eq('id', payeeId)
            .select('id');

        if (updateError) {
            console.error('Toggle Status Error:', updateError);
            return fail(500, { message: '更新狀態失敗：' + updateError.message });
        }
        if (!updatedRows || updatedRows.length === 0) {
            return fail(404, { message: '更新狀態失敗：找不到收款人或目前權限不足' });
        }

        return { success: true, message: `收款人已${newStatus === 'available' ? '啟用' : '停用'}` };
    }
};
