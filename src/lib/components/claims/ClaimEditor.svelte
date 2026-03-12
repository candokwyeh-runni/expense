<script lang="ts">
    import { enhance, deserialize, applyAction } from "$app/forms";
    import { goto } from "$app/navigation";
    import { browser } from "$app/environment";
    import { type Snippet, untrack } from "svelte";
    import { toast } from "svelte-sonner";
    import {
        CLAIM_ITEM_CATEGORIES,
        CLAIM_TYPE_OPTIONS,
        getClaimTypeLabel,
    } from "$lib/claims/constants";
    import AppBadge from "$lib/components/common/AppBadge.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Textarea } from "$lib/components/ui/textarea";
    import * as Card from "$lib/components/ui/card";
    import * as Tabs from "$lib/components/ui/tabs";
    import * as Sheet from "$lib/components/ui/sheet";
    import * as Dialog from "$lib/components/ui/dialog";
    import ListTabs from "$lib/components/common/ListTabs.svelte";
    import ListTabTrigger from "$lib/components/common/ListTabTrigger.svelte";
    import BankCodeCombobox from "$lib/components/layout/BankCodeCombobox.svelte";
    import PayeeCombobox from "$lib/components/layout/PayeeCombobox.svelte";
    import AuditTimeline from "$lib/components/shared/AuditTimeline.svelte";
    import { UI_MESSAGES } from "$lib/constants/ui-messages";
    import {
        handleEnhancedActionFeedback,
        handleFetchActionFeedback,
    } from "$lib/utils/action-feedback";
    import {
        ArrowLeft,
        ReceiptText,
        Save,
        Send,
        Plus,
        Trash2,
        Eye,
        EyeOff,
        Upload,
        ClipboardList,
        FileText,
        CircleX,
        X,
    } from "lucide-svelte";

    export interface ClaimEditorClaim {
        id?: string;
        applicant_id?: string | null;
        claim_type: string;
        status?: string;
        payee_id?: string | null;
        payee_name?: string | null;
        applicant_bank?: string | null;
        applicant_bank_account_tail?: string | null;
        bank_code?: string | null;
        bank_account?: string | null;
        claim_bank_account_tail?: string | null;
        payee_bank?: string | null;
        payee_bank_account_tail?: string | null;
        created_at?: string | null;
        applicant_name?: string | null;
        total_amount?: number | null;
        items: any;
    }

    export interface ClaimEditorPayee {
        id: string;
        name: string;
        type: string;
        bank?: string | null;
        bank_account_tail?: string | null;
        editable_account?: boolean | null;
    }

    const claimTypeDescriptionMap: Record<string, string> = {
        employee: "用於員工本人報銷日常費用，收款對象固定為申請人本人。",
        vendor: "用於公司對廠商付款，需指定已建檔的廠商收款對象。",
        personal_service: "用於個人勞務給付，需指定已建檔的個人收款對象。",
    };

    let {
        claim,
        payees = [],
        categoryOptions = [],
        backHref = "/claims",
        backLabel = "返回清單",
        mode = "edit",
        isCreate = false,
        formAction = "",
        formEnctype,
        submitAction = "",
        showSaveButton = true,
        showSubmitButton = true,
        directSubmitInSameForm = false,
        requireApproverOnDirectSubmit = false,
        hasApprover = true,
        submitButtonLabel,
        timelineTitle = "審核歷程",
        history = [],
        deleteAction,
        headerActions,
        nextAction,
        sidePanel,
        onDeleteSubmit = undefined,
        revealPayeeAccountAction = "?/revealPayeeAccount",
        revealClaimAccountAction = "?/revealClaimAccount",
        revealApplicantAccountAction = "?/revealApplicantAccount",
        supplementItemAction = "?/updateItemVoucher",
    }: {
        claim: ClaimEditorClaim;
        payees?: ClaimEditorPayee[];
        categoryOptions?: Array<{
            id?: string;
            name?: string;
            value?: string;
            label?: string;
            description?: string;
        }>;
        backHref?: string;
        backLabel?: string;
        mode?: "edit" | "supplement" | "review" | "view";
        isCreate?: boolean;
        formAction?: string;
        formEnctype?:
            | "multipart/form-data"
            | "application/x-www-form-urlencoded"
            | "text/plain";
        submitAction?: string;
        showSaveButton?: boolean;
        showSubmitButton?: boolean;
        directSubmitInSameForm?: boolean;
        requireApproverOnDirectSubmit?: boolean;
        hasApprover?: boolean;
        submitButtonLabel?: string;
        timelineTitle?: string;
        history?: any[];
        deleteAction?: string; // New prop for delete action URL
        headerActions?: Snippet;
        nextAction?: Snippet;
        sidePanel?: Snippet;
        onDeleteSubmit?: (e: SubmitEvent) => void;
        revealPayeeAccountAction?: string;
        revealClaimAccountAction?: string;
        revealApplicantAccountAction?: string;
        supplementItemAction?: string;
    } = $props();

    type ClaimEditorItem = {
        id?: string | null;
        date: string;
        date_end: string;
        category: string;
        description: string;
        amount: string | number;
        invoice_number: string;
        attachment_status: "uploaded" | "pending_supplement" | "exempt";
        exempt_reason: string;
        extra: Record<string, any>;
    };

    type CategoryOption = {
        value: string;
        label: string;
        description?: string;
    };

    function normalizeCategoryOptions(
        raw: Array<{
            id?: string;
            name?: string;
            value?: string;
            label?: string;
            description?: string;
        }>,
    ) {
        if (!Array.isArray(raw) || raw.length === 0) {
            return CLAIM_ITEM_CATEGORIES.map((item) => ({
                value: item.value,
                label: item.label,
                description: "",
            }));
        }
        return raw
            .map((item) => {
                const value = String(
                    item?.name || item?.value || item?.label || "",
                ).trim();
                if (!value) return null;
                return {
                    value,
                    label: String(item?.label || item?.name || value).trim(),
                    description: String(item?.description || "").trim(),
                };
            })
            .filter(Boolean) as CategoryOption[];
    }

    const resolvedCategoryOptions = $derived(
        normalizeCategoryOptions(categoryOptions),
    );
    const defaultCategory = $derived.by(() => {
        const match = resolvedCategoryOptions.find(
            (item) => item.value === "一般雜支",
        );
        return match?.value || resolvedCategoryOptions[0]?.value || "一般雜支";
    });

    function emptyItem(): ClaimEditorItem {
        return {
            date: new Date().toISOString().split("T")[0],
            date_end: "",
            category: defaultCategory,
            description: "",
            amount: "",
            invoice_number: "",
            attachment_status: "uploaded",
            exempt_reason: "",
            extra: {},
        };
    }

    function normalizeAttachmentStatus(
        value: unknown,
    ): ClaimEditorItem["attachment_status"] {
        const text = String(value || "pending_supplement");
        if (text === "uploaded" || text === "exempt") return text;
        return "pending_supplement";
    }

    function normalizeItemForEditor(item: any): ClaimEditorItem {
        return {
            id: item?.id || null,
            date: String(
                item?.date ||
                    item?.date_start ||
                    new Date().toISOString().split("T")[0],
            ),
            date_end: String(item?.date_end || ""),
            category: String(item?.category || defaultCategory),
            description: String(item?.description || ""),
            amount:
                item?.amount === null || item?.amount === undefined
                    ? ""
                    : String(item.amount),
            invoice_number: String(item?.invoice_number || ""),
            attachment_status: normalizeAttachmentStatus(
                item?.attachment_status,
            ),
            exempt_reason: String(
                item?.exempt_reason || item?.extra?.exempt_reason || "",
            ),
            extra: item?.extra || {},
        };
    }

    let claimType = $state(untrack(() => claim.claim_type || "employee"));
    let payeeId = $state(untrack(() => claim.payee_id || ""));
    let items = $state<ClaimEditorItem[]>(
        untrack(() => {
            const parsed = Array.isArray(claim.items)
                ? claim.items
                : JSON.parse(claim.items || "[]");
            if (parsed.length === 0) return [];
            return parsed.map(normalizeItemForEditor);
        }),
    );
    let bankCode = $state(untrack(() => claim.bank_code || ""));
    let bankAccount = $state(untrack(() => claim.bank_account || ""));
    let pendingUpload = $state<Record<number, File | null>>({});
    let isSubmitting = $state(false);
    let revealedAccounts = $state<Record<string, string>>({});
    let revealingById = $state<Record<string, boolean>>({});
    let auditDrawerOpen = $state(false);
    let itemDrawerOpen = $state(false);
    let itemDrawerIndex = $state<number | null>(null);
    let itemDraft = $state<ClaimEditorItem>(emptyItem());
    let itemDraftUpload = $state<File | null>(null);
    let itemDraftUploadPreviewUrl = $state<string | null>(null);
    let itemDraftAmountDisplay = $state("");
    let itemDraftSnapshot = $state("");
    let formSubmitIntent = $state<"save" | "submit">("save");
    let showSubmitErrorSummary = $state(false);

    type SubmitCheckIssue = {
        severity: "error" | "warning";
        message: string;
        itemIndex: number | null;
    };

    $effect(() => {
        claimType = claim.claim_type || "employee";
        payeeId = claim.payee_id || "";
        const newItems = Array.isArray(claim.items)
            ? claim.items
            : JSON.parse(claim.items || "[]");
        items =
            newItems.length === 0 ? [] : newItems.map(normalizeItemForEditor);
        bankCode = claim.bank_code || "";
        bankAccount = claim.bank_account || "";
    });

    const isEditable = $derived(mode === "edit");
    const isFinanceReviewMode = $derived(mode === "review");
    const isPersonalService = $derived(claimType === "personal_service");
    const isSupplementMode = $derived(mode === "supplement");
    const canOperateItems = $derived(
        isEditable || isSupplementMode || isFinanceReviewMode,
    );
    const canEditCoreItemFields = $derived(isEditable || isFinanceReviewMode);
    const canEditVoucherSection = $derived(isEditable || isSupplementMode);
    const canSaveItemDraft = $derived(
        canEditVoucherSection || isFinanceReviewMode,
    );

    const vendorPayees = $derived(payees.filter((p) => p.type === "vendor"));
    const personalPayees = $derived(
        payees.filter((p) => p.type === "personal"),
    );
    const payeeQuickCreateHref = $derived.by(() => {
        if (claimType === "vendor") return "/payees/new?type=vendor";
        if (claimType === "personal_service")
            return "/payees/new?type=personal";
        return "";
    });
    const payeeQuickCreateLabel = $derived.by(() => {
        if (claimType === "vendor") return "新增廠商收款人";
        if (claimType === "personal_service") return "新增個人收款人";
        return "新增收款人";
    });
    const selectedPayeeName = $derived.by(() => {
        if (claimType === "employee") return claim.applicant_name || "—";
        const selected = payees.find((p) => p.id === payeeId)?.name;
        if (selected) return selected;
        if (!isCreate && claim.payee_name) return claim.payee_name;
        return "";
    });
    const selectedPayee = $derived(
        payees.find((p) => p.id === payeeId) || null,
    );
    const hasClaimFloatingAccount = $derived(
        claimType !== "employee" && Boolean(String(claim.bank_code || "").trim()),
    );
    const isEditablePayeeAccount = $derived(
        claimType === "vendor" && Boolean(selectedPayee?.editable_account),
    );
    const applicantRevealId = $derived(String(claim.applicant_id || "").trim());
    const selectedPayeeBankLabel = $derived(
        claimType === "employee"
            ? String(claim.applicant_bank || "").trim()
            : isEditablePayeeAccount
              ? bankCode || String(selectedPayee?.bank || "").trim()
            : hasClaimFloatingAccount
              ? String(claim.bank_code || "").trim()
              : selectedPayee?.bank || claim.payee_bank || "",
    );
    const selectedPayeeId = $derived.by(
        () =>
            selectedPayee?.id || (isCreate ? "" : String(claim.payee_id || "")),
    );
    const bankRevealKey = $derived(
        claimType === "employee"
            ? applicantRevealId
            : hasClaimFloatingAccount
              ? String(claim.id || "").trim()
              : selectedPayeeId,
    );
    const selectedPayeeBankAccountMasked = $derived.by(() => {
        const tail =
            claimType === "employee"
                ? String(claim.applicant_bank_account_tail || "").trim()
                : hasClaimFloatingAccount
                  ? String(claim.claim_bank_account_tail || "").trim()
                : String(
                      selectedPayee?.bank_account_tail ||
                          claim.payee_bank_account_tail ||
                          "",
                  ).trim();
        return tail ? `*******${tail.slice(-5)}` : "";
    });
    const selectedPayeeBankAccountDisplay = $derived.by(() => {
        if (isEditablePayeeAccount) return bankAccount;
        const id = bankRevealKey;
        if (id && revealedAccounts[id]) return revealedAccounts[id];
        return selectedPayeeBankAccountMasked;
    });
    const canToggleBankReveal = $derived(Boolean(bankRevealKey));
    const showReadonlyHover = $derived(isEditable && canToggleBankReveal);
    const totalAmount = $derived(
        items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
    );
    const statusPreset = $derived(`status.${claim.status || "draft"}`);
    const displayClaimType = $derived(getClaimTypeLabel(claimType));
    const claimTypeDescription = $derived(
        claimTypeDescriptionMap[claimType] ||
            "請選擇符合此筆請款情境的申請類別。",
    );
    const expenseGridColumns = $derived(
        isEditable
            ? "80px 84px minmax(96px,1fr) 94px 90px minmax(96px,1fr) 54px"
            : "80px 84px minmax(96px,1fr) 94px 90px minmax(96px,1fr)",
    );
    const personalServiceItem = $derived.by(() => {
        if (items.length === 0) return emptyItem();
        return normalizeItemForEditor(items[0]);
    });
    function upsertPersonalServiceItem(
        patch: Partial<ClaimEditorItem>,
        options: { normalizeAmount?: boolean } = {},
    ) {
        const source = items.length > 0 ? items[0] : emptyItem();
        const next = normalizeItemForEditor({ ...source, ...patch });
        next.attachment_status = "exempt";
        next.invoice_number = "";
        next.exempt_reason = "";
        next.extra = {};
        if (options.normalizeAmount) {
            next.amount = String(next.amount || "").replaceAll(",", "");
        }
        items = [next];
    }

    let lastPayeeSelectionKey = $state("");

    async function preloadEditablePayeeBankAccount(targetPayeeId: string) {
        if (!browser) return;
        if (!targetPayeeId) return;
        try {
            const formData = new FormData();
            formData.append("payeeId", targetPayeeId);
            const response = await fetch(revealPayeeAccountAction, {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const result = deserialize(await response.text()) as any;
            if (
                result?.type === "success" &&
                result?.data &&
                "decryptedAccount" in result.data
            ) {
                bankAccount = String(result.data.decryptedAccount || "").trim();
            }
        } catch {
            // 靜默失敗：無法預載時維持可手動輸入
        }
    }

    $effect(() => {
        if (!browser) return;
        if (!isEditable || claimType === "employee") return;
        const selectionKey = `${claimType}:${payeeId}`;
        if (selectionKey === lastPayeeSelectionKey) return;
        lastPayeeSelectionKey = selectionKey;

        const selected = payees.find((p) => p.id === payeeId);
        if (claimType === "vendor" && selected?.editable_account) {
            bankCode = String(selected?.bank || "").trim();
            const existingFloatingAccount = String(
                claim.bank_account || "",
            ).trim();
            bankAccount = existingFloatingAccount;
            if (!existingFloatingAccount && selected?.id) {
                void preloadEditablePayeeBankAccount(selected.id);
            }
            return;
        }
        bankCode = "";
        bankAccount = "";
    });

    // Auto-calculate pay_first_patch_doc: true if any item is pending_supplement
    const payFirstPatchDoc = $derived(
        items.some((item) => item.attachment_status === "pending_supplement"),
    );

    function submitButtonText() {
        if (submitButtonLabel) return submitButtonLabel;
        return isCreate ? "直接提交" : "提交審核";
    }

    async function togglePayeeBankAccountReveal() {
        const id = bankRevealKey;
        if (!id) return;

        if (revealedAccounts[id]) {
            const next = { ...revealedAccounts };
            delete next[id];
            revealedAccounts = next;
            return;
        }

        if (claimType !== "employee" && hasClaimFloatingAccount) {
            const decrypted = String(claim.bank_account || "").trim();
            if (decrypted) {
                revealedAccounts = {
                    ...revealedAccounts,
                    [id]: decrypted,
                };
                return;
            }
        }

        revealingById = { ...revealingById, [id]: true };
        try {
            const formData = new FormData();
            let action = revealPayeeAccountAction;
            if (claimType === "employee") {
                formData.append("targetId", id);
                action = revealApplicantAccountAction;
            } else if (hasClaimFloatingAccount) {
                formData.append("claimId", id);
                action = revealClaimAccountAction;
            } else {
                formData.append("payeeId", id);
            }
            const response = await fetch(action, {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const result = deserialize(await response.text()) as any;
            if (
                result?.type === "success" &&
                result?.data &&
                "decryptedAccount" in result.data
            ) {
                revealedAccounts = {
                    ...revealedAccounts,
                    [id]: String(result.data.decryptedAccount),
                };
            } else {
                toast.error(result?.data?.message || "讀取銀行帳號失敗");
            }
        } catch {
            toast.error(UI_MESSAGES.common.networkFailed("讀取銀行帳號"));
        } finally {
            const next = { ...revealingById };
            delete next[id];
            revealingById = next;
        }
    }

    const voucherDecisionOptions: Array<{
        value: ClaimEditorItem["attachment_status"];
        label: string;
        description: string;
    }> = [
        {
            value: "uploaded",
            label: "上傳憑證",
            description: "有憑證可上傳，建議優先選擇此模式。",
        },
        {
            value: "pending_supplement",
            label: "憑證後補",
            description: "先提單，後續依流程補齊憑證。",
        },
        {
            value: "exempt",
            label: "無憑證",
            description: "無法取得憑證時，需填寫合理原因。",
        },
    ];
    const voucherDecisionChoices = $derived(
        isSupplementMode
            ? voucherDecisionOptions.filter(
                  (option) => option.value !== "pending_supplement",
              )
            : voucherDecisionOptions,
    );

    function voucherDecisionClass(
        value: ClaimEditorItem["attachment_status"],
        active: boolean,
    ) {
        const base =
            "w-full justify-start text-left h-auto px-3 py-2.5 rounded-lg border transition-all";
        if (active) {
            if (value === "uploaded") {
                return `${base} border-blue-200 bg-blue-50 text-blue-700`;
            }
            if (value === "pending_supplement") {
                return `${base} border-amber-200 bg-amber-50 text-amber-700`;
            }
            return `${base} border-rose-200 bg-rose-50 text-rose-700`;
        }
        return `${base} border-muted bg-background text-muted-foreground`;
    }

    function isImageFile(file: File | null) {
        return Boolean(file && file.type.startsWith("image/"));
    }

    function isPdfFile(file: File | null) {
        return Boolean(file && file.type === "application/pdf");
    }

    function isImagePath(path: string) {
        return /\.(png|jpe?g|webp|gif|bmp|svg)(\?.*)?$/i.test(path);
    }

    function isPdfPath(path: string) {
        return /\.pdf(\?.*)?$/i.test(path);
    }

    function getCurrentAttachmentUrl(item: ClaimEditorItem) {
        if (!item?.id || !item?.extra?.file_path) return "";
        return `/api/claims/attachment/${item.id}`;
    }

    function getCurrentAttachmentPath(item: ClaimEditorItem) {
        return String(item?.extra?.file_path || "");
    }

    $effect(() => {
        if (!itemDraftUpload || !isImageFile(itemDraftUpload)) {
            itemDraftUploadPreviewUrl = null;
            return;
        }
        const url = URL.createObjectURL(itemDraftUpload);
        itemDraftUploadPreviewUrl = url;
        return () => URL.revokeObjectURL(url);
    });

    function categoryLabel(value: string) {
        return (
            resolvedCategoryOptions.find((item) => item.value === value)
                ?.label || value
        );
    }

    function itemSnapshot(item: ClaimEditorItem) {
        return JSON.stringify({
            ...item,
            extra: item.extra || {},
        });
    }

    function hasUnsavedItemDraftChanges() {
        return (
            itemSnapshot(itemDraft) !== itemDraftSnapshot ||
            Boolean(itemDraftUpload)
        );
    }

    function openCreateItemDrawer() {
        if (!isEditable) return;
        itemDrawerIndex = null;
        itemDraft = emptyItem();
        itemDraftUpload = null;
        itemDraftAmountDisplay = "";
        itemDraftSnapshot = itemSnapshot(itemDraft);
        itemDrawerOpen = true;
    }

    function openEditItemDrawer(index: number) {
        const target = items[index];
        if (!target) return;
        itemDrawerIndex = index;
        itemDraft = normalizeItemForEditor(target);
        itemDraftUpload = pendingUpload[index] || null;
        itemDraftAmountDisplay = formatAmountInput(itemDraft.amount);
        itemDraftSnapshot = itemSnapshot(itemDraft);
        itemDrawerOpen = true;
    }

    function openPendingAttachment(index: number, event: Event) {
        event.stopPropagation();
        const file = pendingUpload[index];
        if (!file) return;
        const url = URL.createObjectURL(file);
        window.open(url, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function openUploadedAttachment(item: ClaimEditorItem, event: Event) {
        event.stopPropagation();
        if (!item.id) return;
        window.open(
            `/api/claims/attachment/${item.id}`,
            "_blank",
            "noopener,noreferrer",
        );
    }

    function closeItemDrawer() {
        if (hasUnsavedItemDraftChanges()) {
            if (!confirm("尚有未儲存的明細變更，確定要離開嗎？")) return;
        }
        itemDrawerOpen = false;
    }

    function reindexPendingUploadsAfterRemove(removedIndex: number) {
        const next: Record<number, File | null> = {};
        for (const [rawKey, file] of Object.entries(pendingUpload)) {
            const index = Number(rawKey);
            if (Number.isNaN(index) || !file) continue;
            if (index < removedIndex) next[index] = file;
            if (index > removedIndex) next[index - 1] = file;
        }
        pendingUpload = next;
    }

    function removeItem(index: number) {
        if (!isEditable) return;
        items = items.filter((_, i) => i !== index);
        reindexPendingUploadsAfterRemove(index);
    }

    async function uploadAttachmentForItem(
        itemId: string,
        file: File,
        navigateAfter = true,
    ) {
        const fd = new FormData();
        fd.append("item_id", itemId);
        fd.append("file", file);

        const response = await fetch(`/claims/${claim.id}?/upload`, {
            method: "POST",
            body: fd,
            headers: { "x-sveltekit-action": "true" },
        });
        const result = deserialize(await response.text()) as any;
        if (result?.type === "failure") {
            toast.error(
                result?.data?.message || UI_MESSAGES.attachment.uploadFailed,
            );
            return false;
        }
        toast.success(UI_MESSAGES.attachment.uploadSuccess);
        if (navigateAfter) {
            await goto(`/claims/${claim.id}`, { invalidateAll: true });
        }
        return true;
    }

    async function updateItemVoucherDecision(item: ClaimEditorItem) {
        const fd = new FormData();
        fd.append("item_id", String(item.id || ""));
        fd.append("attachment_status", item.attachment_status);
        fd.append("date", String(item.date || ""));
        fd.append("invoice_number", String(item.invoice_number || ""));
        fd.append("exempt_reason", String(item.exempt_reason || ""));

        const response = await fetch(
            `/claims/${claim.id}${supplementItemAction}`,
            {
                method: "POST",
                body: fd,
                headers: { "x-sveltekit-action": "true" },
            },
        );
        const result = deserialize(await response.text()) as any;
        if (result?.type === "failure") {
            toast.error(result?.data?.message || "更新憑證決策失敗");
            return false;
        }
        return true;
    }

    async function updateFinanceReviewedItem(item: ClaimEditorItem) {
        const fd = new FormData();
        fd.append("item_id", String(item.id || ""));
        fd.append("category", String(item.category || ""));
        fd.append(
            "amount",
            String(item.amount || "")
                .replaceAll(",", "")
                .trim(),
        );

        const response = await fetch(`/claims/${claim.id}?/reviewUpdateItem`, {
            method: "POST",
            body: fd,
            headers: { "x-sveltekit-action": "true" },
        });
        const result = deserialize(await response.text()) as any;
        if (result?.type === "failure") {
            toast.error(result?.data?.message || "更新明細失敗");
            return false;
        }
        return true;
    }

    async function saveItemDraft(options?: { keepOpen?: boolean }) {
        const normalized = normalizeItemForEditor(itemDraft);
        normalized.amount = String(itemDraft.amount || "").replaceAll(",", "");
        const status = normalized.attachment_status;
        const hasExistingAttachment = Boolean(
            normalized.id && normalized.extra?.file_path,
        );
        const hasNewAttachment = Boolean(itemDraftUpload);

        if (status === "uploaded") {
            if (!String(normalized.date || "").trim()) {
                toast.error("上傳憑證時，日期為必填");
                return;
            }
            if (!String(normalized.invoice_number || "").trim()) {
                toast.error("上傳憑證時，發票號碼為必填");
                return;
            }
            if (!hasExistingAttachment && !hasNewAttachment) {
                toast.error("上傳憑證時，請先上傳附件才能儲存明細");
                return;
            }
            normalized.exempt_reason = "";
        } else if (status === "exempt") {
            if (!String(normalized.date || "").trim()) {
                toast.error("無憑證時，日期為必填");
                return;
            }
            normalized.invoice_number = "";
        } else {
            normalized.date = "";
            normalized.invoice_number = "";
            normalized.exempt_reason = "";
        }

        if (isSupplementMode) {
            if (status === "pending_supplement") {
                toast.error("補件階段不可再選擇「憑證後補」");
                return;
            }
            if (!normalized.id) {
                toast.error("補件階段僅可編輯既有明細");
                return;
            }
            if (status === "uploaded" && itemDraftUpload) {
                const uploaded = await uploadAttachmentForItem(
                    String(normalized.id),
                    itemDraftUpload,
                    false,
                );
                if (!uploaded) return;
            }
            const saved = await updateItemVoucherDecision(normalized);
            if (!saved) return;
            itemDrawerOpen = false;
            await goto(`/claims/${claim.id}`, { invalidateAll: true });
            return;
        }

        if (isFinanceReviewMode) {
            if (!normalized.id) {
                toast.error("財務審核僅可編輯既有明細");
                return;
            }
            if (!String(normalized.category || "").trim()) {
                toast.error("類別為必填");
                return;
            }
            const amount = Number(
                String(normalized.amount || "").replaceAll(",", ""),
            );
            if (!Number.isFinite(amount) || amount <= 0) {
                toast.error("金額需大於 0");
                return;
            }
            const saved = await updateFinanceReviewedItem(normalized);
            if (!saved) return;
            itemDrawerOpen = false;
            await goto(`/claims/${claim.id}`, { invalidateAll: true });
            return;
        }

        if (itemDrawerIndex === null) {
            const nextIndex = items.length;
            items = [...items, normalized];
            if (
                normalized.attachment_status === "uploaded" &&
                itemDraftUpload
            ) {
                pendingUpload = {
                    ...pendingUpload,
                    [nextIndex]: itemDraftUpload,
                };
            }

            // "儲存並新增下一筆" mode: reset form for next item
            if (options?.keepOpen) {
                const savedCount = items.length;
                toast.success(`已儲存第 ${savedCount} 筆明細 ✓`);
                const nextItem = emptyItem();
                // Inherit date and category from the just-saved item
                nextItem.date =
                    normalized.date || new Date().toISOString().split("T")[0];
                nextItem.category = normalized.category || defaultCategory;
                itemDraft = nextItem;
                itemDraftUpload = null;
                itemDraftAmountDisplay = "";
                itemDraftSnapshot = itemSnapshot(nextItem);
                return; // keep drawer open
            }
        } else {
            const targetIndex = itemDrawerIndex;
            items = items.map((item, idx) =>
                idx === targetIndex ? normalized : item,
            );

            if (normalized.attachment_status !== "uploaded") {
                const next = { ...pendingUpload };
                delete next[targetIndex];
                pendingUpload = next;
            } else if (normalized.id && itemDraftUpload) {
                await uploadAttachmentForItem(normalized.id, itemDraftUpload);
            } else if (itemDraftUpload) {
                pendingUpload = {
                    ...pendingUpload,
                    [targetIndex]: itemDraftUpload,
                };
            }
        }

        itemDrawerOpen = false;
    }

    function formatAmountInput(value: unknown) {
        const digits = String(value ?? "").replace(/[^\d]/g, "");
        if (!digits) return "";
        return new Intl.NumberFormat("en-US", {
            maximumFractionDigits: 0,
        }).format(Number(digits));
    }

    function handleAmountInput(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const digits = input.value.replace(/[^\d]/g, "");
        itemDraft.amount = digits;
        itemDraftAmountDisplay = formatAmountInput(digits);
        input.value = itemDraftAmountDisplay;
    }

    /** 發票號碼：僅允許英文(自動轉大寫)、數字與 dash */
    function handleInvoiceInput(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const cleaned = input.value
            .replace(/[^a-zA-Z0-9\-]/g, "")
            .toUpperCase();
        itemDraft.invoice_number = cleaned;
        input.value = cleaned;
    }

    const submitCheckIssues = $derived.by(() => {
        const next: SubmitCheckIssue[] = [];
        if (isPersonalService) {
            if (items.length !== 1) {
                next.push({
                    severity: "error",
                    message: "個人勞務請款僅能有一筆費用明細",
                    itemIndex: null,
                });
            } else {
                const item = items[0];
                const startDate = String(item?.date || "").trim();
                const endDate = String(item?.date_end || "").trim();
                const category = String(item?.category || "").trim();
                const description = String(item?.description || "").trim();
                const amount = Number(
                    String(item?.amount || "").replaceAll(",", ""),
                );
                if (!startDate || !endDate || !category || !description) {
                    next.push({
                        severity: "error",
                        message: "個人勞務請款需填寫完整明細欄位",
                        itemIndex: 0,
                    });
                }
                if (startDate && endDate && endDate < startDate) {
                    next.push({
                        severity: "error",
                        message: "服務結束日不得早於服務開始日",
                        itemIndex: 0,
                    });
                }
                if (!Number.isFinite(amount) || amount <= 0) {
                    next.push({
                        severity: "error",
                        message: "個人勞務請款金額需大於 0",
                        itemIndex: 0,
                    });
                }
            }
        } else {
            if (items.length === 0) {
                next.push({
                    severity: "error",
                    message: "至少需要一筆費用明細才能提交",
                    itemIndex: null,
                });
            }
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                const status = String(
                    item?.attachment_status || "pending_supplement",
                ).trim();
                const date = String(item?.date || "").trim();
                const invoice = String(item?.invoice_number || "").trim();
                const hasExistingAttachment = Boolean(item?.extra?.file_path);
                const hasPendingAttachment = Boolean(pendingUpload[i]);

                if (
                    status === "exempt" &&
                    !String(item?.exempt_reason || "").trim()
                ) {
                    next.push({
                        severity: "error",
                        message: UI_MESSAGES.claim.exemptReasonRequired(i + 1),
                        itemIndex: i,
                    });
                }
                if (status === "uploaded" && !date) {
                    next.push({
                        severity: "error",
                        message: `第 ${i + 1} 筆明細：日期為必填`,
                        itemIndex: i,
                    });
                }
                if (status === "uploaded" && !invoice) {
                    next.push({
                        severity: "error",
                        message: `第 ${i + 1} 筆明細：發票號碼為必填`,
                        itemIndex: i,
                    });
                }
                if (status === "exempt" && !date) {
                    next.push({
                        severity: "error",
                        message: `第 ${i + 1} 筆明細：日期為必填`,
                        itemIndex: i,
                    });
                }
                if (
                    status === "uploaded" &&
                    !hasExistingAttachment &&
                    !hasPendingAttachment
                ) {
                    next.push({
                        severity: "error",
                        message: UI_MESSAGES.claim.uploadRequired(i + 1),
                        itemIndex: i,
                    });
                }
                if (isSupplementMode && status === "pending_supplement") {
                    next.push({
                        severity: "error",
                        message: `第 ${i + 1} 筆明細仍為「憑證後補」，請完成補件後再送出`,
                        itemIndex: i,
                    });
                }
                if (!isSupplementMode && status === "pending_supplement") {
                    next.push({
                        severity: "warning",
                        message: `第 ${i + 1} 筆明細為「憑證後補」，送出後將進入待補件流程`,
                        itemIndex: i,
                    });
                }
                if (status === "exempt") {
                    next.push({
                        severity: "warning",
                        message: `第 ${i + 1} 筆明細為「無憑證」，請確認理由完整可供審核`,
                        itemIndex: i,
                    });
                }
            }
        }

        if (requireApproverOnDirectSubmit && !hasApprover) {
            next.push({
                severity: "error",
                message: UI_MESSAGES.claim.approverRequired,
                itemIndex: null,
            });
        }
        return next;
    });

    const submitErrors = $derived(
        submitCheckIssues.filter((issue) => issue.severity === "error"),
    );

    function scrollToItemRow(index: number) {
        const row = document.querySelector(
            `[data-testid="claim-item-row-${index}"]`,
        ) as HTMLElement | null;
        if (!row) return;
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("ring-2", "ring-primary/40");
        window.setTimeout(() => {
            row.classList.remove("ring-2", "ring-primary/40");
        }, 900);
    }

    function goToIssue(issue: SubmitCheckIssue) {
        if (issue.itemIndex === null) return;
        scrollToItemRow(issue.itemIndex);
        if (canOperateItems) {
            openEditItemDrawer(issue.itemIndex);
        }
    }

    function validateBeforeDirectSubmit() {
        if (submitErrors.length > 0) {
            showSubmitErrorSummary = true;
            return false;
        }
        showSubmitErrorSummary = false;
        return true;
    }

    function onSubmitCapture(event: SubmitEvent) {
        const submitter = event.submitter as
            | HTMLButtonElement
            | HTMLInputElement
            | null;
        const value = submitter?.value;
        formSubmitIntent = value === "submit" ? "submit" : "save";
        if (value !== "submit") return;
        if (!validateBeforeDirectSubmit()) {
            event.preventDefault();
        }
    }

    async function submitForReview() {
        if (!submitAction || isSubmitting) return;
        if (!validateBeforeDirectSubmit()) return;
        isSubmitting = true;
        try {
            const fd = new FormData();
            fd.append("payee_id", payeeId);
            if (isEditablePayeeAccount) {
                fd.append("is_floating", "on");
                fd.append("bank_code", bankCode);
                fd.append("bank_account", bankAccount);
            }
            fd.append("items", JSON.stringify(items));
            fd.append(
                "pay_first_patch_doc",
                payFirstPatchDoc ? "true" : "false",
            );

            const response = await fetch(submitAction, {
                method: "POST",
                body: fd,
                headers: { "x-sveltekit-action": "true" },
            });
            await handleFetchActionFeedback({
                response,
                successMessage: isSupplementMode
                    ? UI_MESSAGES.claim.supplementSubmitted
                    : UI_MESSAGES.claim.submitted,
                failureMessage: UI_MESSAGES.common.submitFailed,
            });
        } finally {
            isSubmitting = false;
        }
    }

    async function removeAttachment(itemId: string, navigateAfter = true) {
        const fd = new FormData();
        fd.append("item_id", itemId);

        const response = await fetch(`/claims/${claim.id}?/delete_attachment`, {
            method: "POST",
            body: fd,
            headers: { "x-sveltekit-action": "true" },
        });
        const result = deserialize(await response.text()) as any;
        if (result?.type === "failure") {
            toast.error(
                result?.data?.message || UI_MESSAGES.attachment.deleteFailed,
            );
            return;
        }
        toast.success(UI_MESSAGES.attachment.deleteSuccess);
        if (navigateAfter) {
            await goto(`/claims/${claim.id}`, { invalidateAll: true });
        }
    }

    async function clearItemDraftAttachment() {
        if (itemDraft.id && itemDraft.extra?.file_path) {
            await removeAttachment(itemDraft.id, false);
            itemDraft = { ...itemDraft, extra: {} };
        }
        itemDraftUpload = null;
        if (itemDrawerIndex !== null) {
            const next = { ...pendingUpload };
            delete next[itemDrawerIndex];
            pendingUpload = next;
        }
    }
</script>

<div class="space-y-4 pb-16">
    <div class="flex items-center justify-between gap-4">
        <Button
            variant="ghost"
            href={backHref}
            class="h-9 px-3 text-base font-semibold text-muted-foreground hover:text-foreground"
        >
            <ArrowLeft class="mr-1.5 h-4 w-4" />
            {backLabel}
        </Button>

        <div id="claim-header-actions" class="flex items-center gap-2">
            {@render headerActions?.()}
            {#if (isEditable || isSupplementMode) && (showSaveButton || showSubmitButton)}
                {#if isEditable && !isCreate && deleteAction}
                    <Button
                        type="submit"
                        form="claim-delete-form"
                        variant="ghost"
                        size="sm"
                        class="text-red-600 hover:bg-red-50 hover:text-red-700"
                        disabled={isSubmitting}
                        onclick={(e) => {
                            if (
                                !onDeleteSubmit &&
                                !confirm("確定要刪除此草稿嗎？此動作無法復原。")
                            ) {
                                e.preventDefault();
                            }
                        }}
                    >
                        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
                        刪除草稿
                    </Button>
                {/if}
                {#if showSaveButton}
                    <Button
                        type="submit"
                        form="claim-editor-form"
                        variant="outline"
                        size="sm"
                        formnovalidate
                        disabled={isSubmitting}
                    >
                        <Save class="mr-1.5 h-3.5 w-3.5" />
                        {isCreate ? "儲存草稿" : "儲存變更"}
                    </Button>
                {/if}
                {#if showSubmitButton}
                    {#if directSubmitInSameForm}
                        <Button
                            type="submit"
                            form="claim-editor-form"
                            formaction={submitAction || undefined}
                            id="claim-submit-button"
                            name="submit_intent"
                            value="submit"
                            size="sm"
                            disabled={isSubmitting}
                        >
                            <Send class="mr-1.5 h-3.5 w-3.5" />
                            {submitButtonText()}
                        </Button>
                    {:else}
                        <Button
                            type="button"
                            size="sm"
                            id="claim-submit-button"
                            disabled={isSubmitting}
                            onclick={submitForReview}
                        >
                            <Send class="mr-1.5 h-3.5 w-3.5" />
                            {submitButtonText()}
                        </Button>
                    {/if}
                {/if}
            {/if}
        </div>
    </div>

    {@render nextAction?.()}

    {#if (isEditable || isSupplementMode) && showSubmitButton && showSubmitErrorSummary && submitErrors.length > 0}
        <div class="rounded-xl border border-red-300 bg-red-50 p-0.5">
            <div class="space-y-1">
                {#each submitErrors as issue}
                    <button
                        type="button"
                        class={`flex w-full items-start gap-2 rounded px-2 py-0.5 text-left text-[11px] leading-4 font-normal text-red-700 ${
                            issue.itemIndex !== null
                                ? "cursor-pointer hover:bg-red-100"
                                : "cursor-default"
                        }`}
                        onclick={() => goToIssue(issue)}
                    >
                        <CircleX class="mt-0.5 h-4 w-4 shrink-0" />
                        <span class="leading-4">{issue.message}</span>
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    <form
        id="claim-delete-form"
        method="POST"
        action={deleteAction}
        onsubmitcapture={(e) => {
            if (onDeleteSubmit) {
                onDeleteSubmit(e);
            }
        }}
        use:enhance={() => {
            isSubmitting = true;
            return async ({ result, update }) => {
                isSubmitting = false;
                await handleEnhancedActionFeedback({
                    result,
                    update,
                    failureMessage: UI_MESSAGES.common.deleteFailed,
                });
            };
        }}
    ></form>

    <form
        id="claim-editor-form"
        method="POST"
        action={formAction}
        enctype={formEnctype || undefined}
        onsubmitcapture={onSubmitCapture}
        use:enhance={({ formData }) => {
            for (const [rawIndex, file] of Object.entries(pendingUpload)) {
                const index = Number(rawIndex);
                if (Number.isNaN(index) || !file) continue;
                const item = items[index];
                if (!item || item.id) continue;
                if (item.attachment_status !== "uploaded") continue;
                formData.set(`item_attachment_${index}`, file);
            }
            isSubmitting = true;
            return async ({ result }) => {
                isSubmitting = false;
                const hasInlineSubmitErrors =
                    formSubmitIntent === "submit" && submitErrors.length > 0;

                if (result?.type === "failure" && hasInlineSubmitErrors) {
                    // 已有頁面內卡控提示時，不再重複顯示左下角 toast。
                    await applyAction(result);
                    return;
                }

                await handleEnhancedActionFeedback({
                    result,
                    update: () => applyAction(result),
                    successMessage:
                        formSubmitIntent === "submit"
                            ? isSupplementMode
                                ? UI_MESSAGES.claim.supplementSubmitted
                                : UI_MESSAGES.claim.submitted
                            : undefined,
                    failureMessage:
                        formSubmitIntent === "submit"
                            ? UI_MESSAGES.common.submitFailed
                            : UI_MESSAGES.common.actionFailed,
                });
            };
        }}
    >
        <input type="hidden" name="claim_type" value={claimType} />
        <input type="hidden" name="items" value={JSON.stringify(items)} />
        <input type="hidden" name="payee_id" value={payeeId} />
        <input
            type="hidden"
            name="is_floating_account"
            value={isEditablePayeeAccount ? "true" : "false"}
        />
        <input
            type="hidden"
            name="bank_code"
            value={isEditablePayeeAccount ? bankCode : ""}
        />
        <input
            type="hidden"
            name="bank_account"
            value={isEditablePayeeAccount ? bankAccount : ""}
        />
        <input type="hidden" name="total_amount" value={totalAmount} />
        <input
            type="hidden"
            name="pay_first_patch_doc"
            value={payFirstPatchDoc ? "true" : "false"}
        />

        <div class="space-y-4">
            <!-- Header + Basic Info (single container) -->
            <Card.Root
                class="overflow-visible rounded-xl border border-border/40 bg-background"
            >
                <div class="px-5 py-3.5">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-3">
                            <div
                                class="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                            >
                                <ReceiptText class="h-4.5 w-4.5" />
                            </div>
                            <div class="space-y-0.5">
                                <div class="flex items-center gap-2">
                                    <h1
                                        class="text-base font-semibold leading-tight"
                                    >
                                        請款單
                                        <span
                                            class="ml-1 text-muted-foreground/40"
                                            >#{claim.id
                                                ? claim.id.slice(0, 8)
                                                : "NEW"}</span
                                        >
                                    </h1>
                                    <div class="flex items-center gap-1.5">
                                        <AppBadge
                                            preset={statusPreset}
                                            className="font-semibold"
                                        />
                                        <AppBadge
                                            preset={`claim.type.${claim.claim_type || "employee"}`}
                                            label={displayClaimType}
                                            className="font-semibold"
                                        />
                                    </div>
                                </div>
                                <p class="text-xs text-muted-foreground">
                                    {claim.created_at
                                        ? `${new Date(claim.created_at).toLocaleDateString("zh-TW")} 建立`
                                        : "建立新請款單"}
                                    <span class="mx-1.5 text-border">·</span>
                                    申請人: {claim.applicant_name || "—"}
                                </p>
                            </div>
                        </div>

                        <div class="flex items-center gap-3">
                            <div class="text-right">
                                <p
                                    class="text-xs font-medium text-muted-foreground"
                                >
                                    請款總額
                                </p>
                                <p
                                    class="text-xl font-bold tabular-nums tracking-tight"
                                >
                                    NT${new Intl.NumberFormat("en-US", {
                                        maximumFractionDigits: 0,
                                    }).format(totalAmount)}
                                </p>
                            </div>
                            <button
                                type="button"
                                class="relative flex h-8 w-8 items-center justify-center rounded-lg border border-border/40 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                                onclick={() => (auditDrawerOpen = true)}
                                title="審核歷程"
                            >
                                <ClipboardList class="h-3.5 w-3.5" />
                                {#if history.length > 0}
                                    <span
                                        class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                                        >{history.length}</span
                                    >
                                {/if}
                            </button>
                        </div>
                    </div>
                </div>

                <div class="border-t border-border/30">
                    <div class="flex flex-wrap items-center gap-3 px-5 py-3">
                        <div class="min-w-[280px] flex-1">
                            <div class="flex flex-wrap gap-3">
                                <div
                                    class="min-w-[280px] flex-1 grid grid-cols-1 gap-1.5"
                                >
                                    <Label
                                        class="text-xs font-medium text-muted-foreground"
                                        >收款人</Label
                                    >
                                    {#if claimType === "employee"}
                                        <Input
                                            value={claim.applicant_name || "—"}
                                            disabled={true}
                                            class="h-8 w-full text-left text-xs font-medium"
                                        />
                                    {:else if isEditable}
                                        <PayeeCombobox
                                            bind:value={payeeId}
                                            options={(claimType === "vendor"
                                                ? vendorPayees
                                                : personalPayees
                                            ).map((payee) => ({
                                                id: payee.id,
                                                name: payee.name,
                                            }))}
                                            placeholder="請選擇收款人"
                                            inputClass="h-8 text-xs"
                                            quickActionHref={payeeQuickCreateHref}
                                            quickActionLabel={payeeQuickCreateLabel}
                                        />
                                    {:else}
                                        <Input
                                            value={selectedPayeeName ||
                                                "請選擇收款人"}
                                            disabled
                                            class="h-8 w-full text-left text-xs"
                                        />
                                    {/if}
                                </div>

                                <div
                                    class="min-w-[320px] flex-1 grid grid-cols-[1.15fr_1.85fr] gap-3"
                                >
                                    <div
                                        class="min-w-0 grid grid-cols-1 gap-1.5"
                                    >
                                        <Label
                                            class="text-xs font-medium text-muted-foreground"
                                            >銀行代碼</Label
                                        >
                                        {#if isEditablePayeeAccount && isEditable}
                                            <BankCodeCombobox
                                                id="inline_bank_code"
                                                name="inline_bank_code"
                                                bind:value={bankCode}
                                                required
                                            />
                                        {:else}
                                            <Input
                                                value={selectedPayeeBankLabel ||
                                                    "-"}
                                                disabled
                                                class="h-8 w-full text-xs"
                                            />
                                        {/if}
                                    </div>

                                    <div
                                        class="min-w-0 grid grid-cols-1 gap-1.5"
                                    >
                                        <Label
                                            class="text-xs font-medium text-muted-foreground"
                                            >銀行帳號</Label
                                        >
                                        {#if isEditablePayeeAccount && isEditable}
                                            <Input
                                                value={bankAccount}
                                                inputmode="numeric"
                                                oninput={(event) => {
                                                    const input =
                                                        event.currentTarget as HTMLInputElement;
                                                    input.value =
                                                        input.value.replace(
                                                            /[^\d]/g,
                                                            "",
                                                        );
                                                    bankAccount = input.value;
                                                }}
                                                placeholder="請輸入本次匯款帳號"
                                                class="h-8 w-full text-xs"
                                            />
                                        {:else}
                                            <div class="relative">
                                                <Input
                                                    value={selectedPayeeBankAccountDisplay ||
                                                        "-"}
                                                    disabled
                                                    class="h-8 w-full pr-10 text-xs"
                                                />
                                                <button
                                                    type="button"
                                                    class={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground ${
                                                        showReadonlyHover
                                                            ? "hover:bg-muted/60 hover:text-foreground"
                                                            : "cursor-not-allowed opacity-60"
                                                    }`}
                                                    onclick={togglePayeeBankAccountReveal}
                                                    disabled={!bankRevealKey ||
                                                        revealingById[
                                                            bankRevealKey || ""
                                                        ]}
                                                    title={revealedAccounts[
                                                        bankRevealKey || ""
                                                    ]
                                                        ? "隱藏完整帳號"
                                                        : "顯示完整帳號"}
                                                >
                                                    {#if revealedAccounts[bankRevealKey || ""]}
                                                        <Eye
                                                            class="h-3.5 w-3.5"
                                                        />
                                                    {:else}
                                                        <EyeOff
                                                            class="h-3.5 w-3.5"
                                                        />
                                                    {/if}
                                                </button>
                                            </div>
                                        {/if}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </Card.Root>

            <!-- Main Content (single column) -->
            <div class="space-y-5">
                <!-- 費用明細 -->
                <section class="space-y-2">
                    <h2
                        class="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                        費用明細
                    </h2>
                    {#if isPersonalService && !isFinanceReviewMode}
                        <Card.Root
                            class="overflow-hidden rounded-xl border border-border/40"
                        >
                            <Card.Content class="p-3">
                                <div
                                    class="grid grid-cols-1 gap-2 md:grid-cols-4 xl:grid-cols-6"
                                >
                                    <div class="space-y-1.5">
                                        <Label
                                            class="text-xs text-muted-foreground"
                                            >服務開始日</Label
                                        >
                                        <Input
                                            type="date"
                                            value={personalServiceItem.date}
                                            disabled={!isEditable}
                                            oninput={(event) =>
                                                upsertPersonalServiceItem({
                                                    date: (
                                                        event.currentTarget as HTMLInputElement
                                                    ).value,
                                                })}
                                        />
                                    </div>
                                    <div class="space-y-1.5">
                                        <Label
                                            class="text-xs text-muted-foreground"
                                            >服務結束日</Label
                                        >
                                        <Input
                                            type="date"
                                            value={personalServiceItem.date_end}
                                            disabled={!isEditable}
                                            oninput={(event) =>
                                                upsertPersonalServiceItem({
                                                    date_end: (
                                                        event.currentTarget as HTMLInputElement
                                                    ).value,
                                                })}
                                        />
                                    </div>
                                    <div class="space-y-1.5">
                                        <Label
                                            class="text-xs text-muted-foreground"
                                            >類別</Label
                                        >
                                        <select
                                            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            value={personalServiceItem.category}
                                            disabled={!isEditable}
                                            oninput={(event) =>
                                                upsertPersonalServiceItem({
                                                    category: (
                                                        event.currentTarget as HTMLSelectElement
                                                    ).value,
                                                })}
                                        >
                                            {#each resolvedCategoryOptions as cat}
                                                <option value={cat.value}
                                                    >{cat.label}</option
                                                >
                                            {/each}
                                        </select>
                                    </div>
                                    <div class="space-y-1.5">
                                        <Label
                                            class="text-xs text-muted-foreground"
                                            >金額</Label
                                        >
                                        <Input
                                            inputmode="numeric"
                                            value={formatAmountInput(
                                                personalServiceItem.amount,
                                            )}
                                            disabled={!isEditable}
                                            class="text-right"
                                            oninput={(event) =>
                                                upsertPersonalServiceItem(
                                                    {
                                                        amount: (
                                                            event.currentTarget as HTMLInputElement
                                                        ).value.replace(
                                                            /[^\d]/g,
                                                            "",
                                                        ),
                                                    },
                                                    { normalizeAmount: true },
                                                )}
                                        />
                                    </div>
                                    <div
                                        class="space-y-1.5 md:col-span-4 xl:col-span-2"
                                    >
                                        <Label
                                            class="text-xs text-muted-foreground"
                                            >說明</Label
                                        >
                                        <Input
                                            value={personalServiceItem.description}
                                            disabled={!isEditable}
                                            placeholder="請輸入服務內容說明"
                                            oninput={(event) =>
                                                upsertPersonalServiceItem({
                                                    description: (
                                                        event.currentTarget as HTMLInputElement
                                                    ).value,
                                                })}
                                        />
                                    </div>
                                </div>
                            </Card.Content>
                        </Card.Root>
                    {:else}
                        <Card.Root
                            class="overflow-hidden rounded-xl border border-border/40"
                        >
                            <Card.Content class="p-0">
                                <div class="overflow-x-auto">
                                    <div class="min-w-[700px]">
                                        <div
                                            class="grid items-center gap-2 border-b border-border/30 bg-muted/20 px-4 py-2.5"
                                            style={`grid-template-columns:${expenseGridColumns};`}
                                        >
                                            <span
                                                class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                >日期</span
                                            >
                                            <span
                                                class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                >類別</span
                                            >
                                            <span
                                                class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                >說明</span
                                            >
                                            <span
                                                class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                >發票號碼</span
                                            >
                                            <span
                                                class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                >金額</span
                                            >
                                            <span
                                                class="text-center text-xs font-semibold text-muted-foreground"
                                                >憑證</span
                                            >
                                            {#if isEditable}
                                                <span
                                                    class="whitespace-nowrap text-center text-xs font-semibold text-muted-foreground"
                                                    >操作</span
                                                >
                                            {/if}
                                        </div>

                                        {#if items.length > 0}
                                            {#each items as item, i}
                                                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                                                <div
                                                    class={`grid items-center gap-2 border-b border-border/20 px-4 py-2 ${
                                                        canOperateItems
                                                            ? "cursor-pointer hover:bg-primary/5 transition-colors"
                                                            : ""
                                                    }`}
                                                    style={`grid-template-columns:${expenseGridColumns};`}
                                                    data-testid={`claim-item-row-${i}`}
                                                    role={canOperateItems
                                                        ? "button"
                                                        : undefined}
                                                    tabindex={canOperateItems
                                                        ? 0
                                                        : undefined}
                                                    onclick={() => {
                                                        if (!canOperateItems)
                                                            return;
                                                        openEditItemDrawer(i);
                                                    }}
                                                    onkeydown={(event) => {
                                                        if (!canOperateItems)
                                                            return;
                                                        if (
                                                            event.key ===
                                                                "Enter" ||
                                                            event.key === " "
                                                        ) {
                                                            event.preventDefault();
                                                            openEditItemDrawer(
                                                                i,
                                                            );
                                                        }
                                                    }}
                                                >
                                                    <span
                                                        class="whitespace-nowrap text-center text-xs"
                                                        >{item.date ||
                                                            "—"}</span
                                                    >
                                                    <span
                                                        class="whitespace-nowrap text-center text-xs"
                                                        >{categoryLabel(
                                                            item.category,
                                                        )}</span
                                                    >
                                                    <span
                                                        class="line-clamp-2 break-words text-xs"
                                                        >{item.description ||
                                                            "—"}</span
                                                    >
                                                    <span
                                                        class="whitespace-nowrap text-center text-xs"
                                                        >{item.invoice_number ||
                                                            "—"}</span
                                                    >
                                                    <div
                                                        class="flex items-center justify-between gap-1 whitespace-nowrap text-xs tabular-nums"
                                                    >
                                                        <span
                                                            class="text-muted-foreground"
                                                            >NT$</span
                                                        >
                                                        <span
                                                            class="font-medium text-foreground"
                                                        >
                                                            {new Intl.NumberFormat(
                                                                "en-US",
                                                                {
                                                                    maximumFractionDigits: 0,
                                                                },
                                                            ).format(
                                                                Number(
                                                                    item.amount,
                                                                ) || 0,
                                                            )}
                                                        </span>
                                                    </div>
                                                    <div
                                                        class="text-center text-xs"
                                                    >
                                                        {#if item.attachment_status === "uploaded"}
                                                            {#if item.extra?.file_path && item.id}
                                                                <span
                                                                    role="link"
                                                                    tabindex="0"
                                                                    class="inline-flex items-center gap-1 text-primary hover:underline"
                                                                    onclick={(
                                                                        e,
                                                                    ) =>
                                                                        openUploadedAttachment(
                                                                            item,
                                                                            e,
                                                                        )}
                                                                    onkeydown={(
                                                                        e,
                                                                    ) => {
                                                                        if (
                                                                            e.key ===
                                                                                "Enter" ||
                                                                            e.key ===
                                                                                " "
                                                                        ) {
                                                                            e.preventDefault();
                                                                            openUploadedAttachment(
                                                                                item,
                                                                                e,
                                                                            );
                                                                        }
                                                                    }}
                                                                >
                                                                    <Eye
                                                                        class="h-3 w-3"
                                                                    /> 查看附件
                                                                </span>
                                                            {:else if pendingUpload[i]}
                                                                <span
                                                                    role="link"
                                                                    tabindex="0"
                                                                    class="inline-flex items-center gap-1 text-primary hover:underline"
                                                                    onclick={(
                                                                        event,
                                                                    ) =>
                                                                        openPendingAttachment(
                                                                            i,
                                                                            event,
                                                                        )}
                                                                    onkeydown={(
                                                                        event,
                                                                    ) => {
                                                                        if (
                                                                            event.key ===
                                                                                "Enter" ||
                                                                            event.key ===
                                                                                " "
                                                                        ) {
                                                                            event.preventDefault();
                                                                            openPendingAttachment(
                                                                                i,
                                                                                event,
                                                                            );
                                                                        }
                                                                    }}
                                                                >
                                                                    <Eye
                                                                        class="h-3 w-3"
                                                                    />
                                                                    查看附件
                                                                </span>
                                                            {:else}
                                                                <span
                                                                    class="break-words text-destructive"
                                                                    >未上傳憑證</span
                                                                >
                                                            {/if}
                                                        {:else if item.attachment_status === "pending_supplement"}
                                                            <span
                                                                class="break-words text-muted-foreground"
                                                                >憑證後補</span
                                                            >
                                                        {:else}
                                                            <span
                                                                class="line-clamp-2 break-words text-muted-foreground"
                                                            >
                                                                {item.exempt_reason ||
                                                                    "無憑證"}
                                                            </span>
                                                        {/if}
                                                    </div>
                                                    {#if isEditable}
                                                        <div
                                                            class="flex items-center justify-center gap-1"
                                                        >
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="icon"
                                                                class="h-7 w-7"
                                                                onclick={(
                                                                    event,
                                                                ) => {
                                                                    event.stopPropagation();
                                                                    removeItem(
                                                                        i,
                                                                    );
                                                                }}
                                                            >
                                                                <Trash2
                                                                    class="h-3.5 w-3.5 text-destructive"
                                                                />
                                                            </Button>
                                                        </div>
                                                    {/if}
                                                </div>
                                            {/each}
                                        {/if}

                                        {#if isEditable}
                                            <div
                                                class={`px-4 py-2 bg-primary/[0.03] ${
                                                    items.length > 0
                                                        ? "border-t border-border/20"
                                                        : ""
                                                }`}
                                            >
                                                <button
                                                    type="button"
                                                    class="flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/[0.06]"
                                                    onclick={openCreateItemDrawer}
                                                >
                                                    <Plus class="h-4 w-4" />
                                                    新增明細
                                                </button>
                                            </div>
                                        {/if}
                                    </div>
                                </div>
                            </Card.Content>
                        </Card.Root>
                    {/if}
                </section>
            </div>
        </div>
    </form>

    <Dialog.Root bind:open={itemDrawerOpen}>
        <Dialog.Content class="max-w-3xl overflow-visible rounded-2xl">
            <Dialog.Header>
                <Dialog.Title
                    >{itemDrawerIndex === null
                        ? "新增費用明細"
                        : "編輯費用明細"}</Dialog.Title
                >
                <Dialog.Description
                    >請在此填寫單筆費用與憑證資訊。</Dialog.Description
                >
            </Dialog.Header>
            <div class="space-y-4 pt-2">
                <section
                    class="rounded-lg border border-border/40 bg-muted/10 p-3"
                >
                    {#if isSupplementMode}
                        <div
                            class="grid grid-cols-1 gap-3 text-sm md:grid-cols-3"
                        >
                            <div
                                class="rounded-md border bg-background px-3 py-2"
                            >
                                <p class="text-xs text-muted-foreground">
                                    類別
                                </p>
                                <p class="mt-1 font-medium">
                                    {categoryLabel(itemDraft.category)}
                                </p>
                            </div>
                            <div
                                class="rounded-md border bg-background px-3 py-2"
                            >
                                <p class="text-xs text-muted-foreground">
                                    說明
                                </p>
                                <p class="mt-1 font-medium">
                                    {itemDraft.description || "—"}
                                </p>
                            </div>
                            <div
                                class="rounded-md border bg-background px-3 py-2"
                            >
                                <p class="text-xs text-muted-foreground">
                                    金額
                                </p>
                                <p class="mt-1 font-medium">
                                    {Number(
                                        itemDraft.amount || 0,
                                    ).toLocaleString("en-US")}
                                </p>
                            </div>
                        </div>
                    {:else}
                        <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
                            <div class="space-y-1.5 overflow-visible">
                                <Label for="item-category">類別</Label>
                                <select
                                    id="item-category"
                                    class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    bind:value={itemDraft.category}
                                    disabled={!canEditCoreItemFields}
                                >
                                    {#each resolvedCategoryOptions as cat}
                                        <option value={cat.value}
                                            >{cat.label}</option
                                        >
                                    {/each}
                                </select>
                            </div>
                            <div class="space-y-1.5">
                                <Label for="item-description">說明</Label>
                                <Input
                                    id="item-description"
                                    bind:value={itemDraft.description}
                                    placeholder="請輸入費用說明"
                                    disabled={!isEditable}
                                />
                            </div>
                            <div class="space-y-1.5">
                                <Label for="item-amount">金額</Label>
                                <Input
                                    id="item-amount"
                                    type="text"
                                    inputmode="numeric"
                                    value={itemDraftAmountDisplay}
                                    oninput={handleAmountInput}
                                    placeholder="0"
                                    disabled={!canEditCoreItemFields}
                                    class="text-right"
                                />
                            </div>
                        </div>
                    {/if}
                </section>

                <section
                    class="rounded-lg border border-border/40 bg-muted/10 p-3"
                >
                    <div class="space-y-3">
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {#each voucherDecisionChoices as option}
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={!canEditVoucherSection}
                                    class={voucherDecisionClass(
                                        option.value,
                                        itemDraft.attachment_status ===
                                            option.value,
                                    )}
                                    onclick={() => {
                                        if (!canEditVoucherSection) return;
                                        const nextDate =
                                            option.value ===
                                            "pending_supplement"
                                                ? ""
                                                : itemDraft.date;
                                        const nextInvoice =
                                            option.value === "uploaded"
                                                ? itemDraft.invoice_number
                                                : "";
                                        itemDraft = {
                                            ...itemDraft,
                                            attachment_status: option.value,
                                            date: nextDate,
                                            invoice_number: nextInvoice,
                                            exempt_reason:
                                                option.value === "exempt"
                                                    ? itemDraft.exempt_reason
                                                    : "",
                                        };
                                        if (option.value !== "uploaded") {
                                            itemDraftUpload = null;
                                        }
                                    }}
                                >
                                    <div
                                        class="flex w-full flex-col items-start gap-1 text-left"
                                    >
                                        <span class="text-sm font-semibold"
                                            >{option.label}</span
                                        >
                                        <span
                                            class="text-xs leading-snug whitespace-normal break-words opacity-80"
                                            >{option.description}</span
                                        >
                                    </div>
                                </Button>
                            {/each}
                        </div>

                        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <div class="space-y-3">
                                <div class="space-y-1.5">
                                    <Label for="item-date">發票/交易日期</Label>
                                    <Input
                                        id="item-date"
                                        type="date"
                                        bind:value={itemDraft.date}
                                        disabled={!canEditVoucherSection ||
                                            itemDraft.attachment_status ===
                                                "pending_supplement"}
                                        class={`pr-12 [&::-webkit-calendar-picker-indicator]:-translate-x-2 [&::-webkit-calendar-picker-indicator]:cursor-pointer ${
                                            itemDraft.attachment_status ===
                                            "pending_supplement"
                                                ? "bg-muted/50 text-muted-foreground"
                                                : ""
                                        }`}
                                    />
                                </div>
                                <div class="space-y-1.5">
                                    <Label for="item-invoice">發票號碼</Label>
                                    <Input
                                        id="item-invoice"
                                        value={itemDraft.invoice_number}
                                        oninput={handleInvoiceInput}
                                        placeholder="AB12345678"
                                        disabled={!canEditVoucherSection ||
                                            itemDraft.attachment_status !==
                                                "uploaded"}
                                        class={itemDraft.attachment_status !==
                                        "uploaded"
                                            ? "bg-muted/50 text-muted-foreground"
                                            : ""}
                                    />
                                </div>
                            </div>

                            <div
                                class="self-start rounded-lg border border-border/40 bg-background/60 p-3 md:col-span-2"
                            >
                                {#if itemDraft.attachment_status === "uploaded"}
                                    <div class="space-y-2">
                                        {#if itemDraft.id && itemDraft.extra?.file_path}
                                            <a
                                                href={getCurrentAttachmentUrl(
                                                    itemDraft,
                                                )}
                                                target="_blank"
                                                class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                            >
                                                <Eye class="h-4 w-4" /> 查看附件
                                            </a>
                                            <div
                                                class="relative rounded-md border border-border/50 bg-background/70 p-2"
                                            >
                                                {#if canEditVoucherSection}
                                                    <button
                                                        type="button"
                                                        class="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-destructive"
                                                        onclick={() =>
                                                            void clearItemDraftAttachment()}
                                                        title="移除附件"
                                                    >
                                                        <X
                                                            class="h-3.5 w-3.5"
                                                        />
                                                    </button>
                                                {/if}
                                                {#if isImagePath(getCurrentAttachmentPath(itemDraft))}
                                                    <img
                                                        src={getCurrentAttachmentUrl(
                                                            itemDraft,
                                                        )}
                                                        alt="目前附件"
                                                        class="h-24 w-full rounded object-cover"
                                                    />
                                                {:else if isPdfPath(getCurrentAttachmentPath(itemDraft))}
                                                    <div
                                                        class="flex h-24 items-center gap-2 rounded bg-muted/40 px-3 text-sm text-muted-foreground"
                                                    >
                                                        <FileText
                                                            class="h-4 w-4"
                                                        />
                                                        <span class="truncate"
                                                            >PDF 檔案</span
                                                        >
                                                    </div>
                                                {/if}
                                            </div>
                                        {/if}
                                        {#if canEditVoucherSection && !(itemDraft.id && itemDraft.extra?.file_path) && !itemDraftUpload}
                                            <label
                                                class="inline-flex cursor-pointer items-center gap-2 text-sm text-primary hover:underline"
                                            >
                                                <Upload class="h-4 w-4" />
                                                {itemDraft.id
                                                    ? "重新上傳附件"
                                                    : "選擇附件"}
                                                <input
                                                    type="file"
                                                    class="hidden"
                                                    onchange={(event) => {
                                                        const input =
                                                            event.currentTarget as HTMLInputElement;
                                                        itemDraftUpload =
                                                            input.files?.[0] ||
                                                            null;
                                                    }}
                                                />
                                            </label>
                                        {/if}
                                        {#if itemDraftUpload}
                                            <div
                                                class="relative space-y-1.5 rounded-md border border-border/50 bg-background/70 p-2"
                                            >
                                                {#if canEditVoucherSection}
                                                    <button
                                                        type="button"
                                                        class="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground hover:text-destructive"
                                                        onclick={() =>
                                                            void clearItemDraftAttachment()}
                                                        title="移除附件"
                                                    >
                                                        <X
                                                            class="h-3.5 w-3.5"
                                                        />
                                                    </button>
                                                {/if}
                                                <p
                                                    class="text-xs text-muted-foreground"
                                                >
                                                    已選擇：{itemDraftUpload.name}
                                                </p>
                                                {#if isImageFile(itemDraftUpload) && itemDraftUploadPreviewUrl}
                                                    <img
                                                        src={itemDraftUploadPreviewUrl}
                                                        alt="附件預覽"
                                                        class="h-24 w-full rounded object-cover"
                                                    />
                                                {:else if isPdfFile(itemDraftUpload)}
                                                    <div
                                                        class="flex h-20 items-center gap-2 rounded bg-muted/40 px-3 text-sm text-muted-foreground"
                                                    >
                                                        <FileText
                                                            class="h-4 w-4"
                                                        />
                                                        <span class="truncate"
                                                            >{itemDraftUpload.name}</span
                                                        >
                                                    </div>
                                                {/if}
                                            </div>
                                        {:else if !(itemDraft.id && itemDraft.extra?.file_path)}
                                            <p class="text-xs text-amber-600">
                                                尚未上傳憑證。提交前請確認已附上附件。
                                            </p>
                                        {/if}
                                    </div>
                                {:else if itemDraft.attachment_status === "pending_supplement"}
                                    <div class="space-y-2 text-sm">
                                        <p class="font-semibold text-amber-700">
                                            憑證後補流程
                                        </p>
                                        <p class="text-muted-foreground">
                                            此筆明細先以待補件送出，後續請在規定期限內補上憑證附件。
                                        </p>
                                        <p class="text-xs text-amber-600">
                                            若未如期補件，可能影響撥款或後續核銷作業。
                                        </p>
                                    </div>
                                {:else}
                                    <div class="space-y-1.5">
                                        <Label for="item-exempt-reason"
                                            >無憑證原因</Label
                                        >
                                        <Textarea
                                            id="item-exempt-reason"
                                            bind:value={itemDraft.exempt_reason}
                                            placeholder="請具體描述無法提供憑證的情境，供審核時判斷"
                                            class="min-h-[92px]"
                                            disabled={!canEditVoucherSection}
                                        />
                                    </div>
                                {/if}
                            </div>
                        </div>
                    </div>
                </section>

                <div class="flex items-center justify-end gap-2 border-t pt-4">
                    <Button
                        type="button"
                        variant="outline"
                        onclick={closeItemDrawer}
                        >{canSaveItemDraft ? "取消" : "關閉"}</Button
                    >
                    {#if canSaveItemDraft}
                        <Button
                            type="button"
                            variant={itemDrawerIndex === null
                                ? "outline"
                                : "default"}
                            onclick={() => void saveItemDraft()}
                            >{itemDrawerIndex === null
                                ? "儲存並關閉"
                                : "儲存明細"}</Button
                        >
                        {#if itemDrawerIndex === null}
                            <Button
                                type="button"
                                onclick={() =>
                                    void saveItemDraft({ keepOpen: true })}
                                >儲存並新增下一筆</Button
                            >
                        {/if}
                    {/if}
                </div>
            </div>
        </Dialog.Content>
    </Dialog.Root>

    <!-- Audit History Sheet Drawer -->
    <Sheet.Root bind:open={auditDrawerOpen}>
        <Sheet.Content class="w-[340px] sm:w-[400px]">
            <Sheet.Header>
                <Sheet.Title>{timelineTitle}</Sheet.Title>
                <Sheet.Description
                    >此請款單的審核紀錄與流程進度</Sheet.Description
                >
            </Sheet.Header>
            <div class="flex-1 overflow-y-auto px-1 py-4">
                {#if history.length > 0}
                    <AuditTimeline {history} />
                {:else}
                    <div
                        class="flex flex-col items-center justify-center py-12 text-center"
                    >
                        <ClipboardList
                            class="mb-3 h-8 w-8 text-muted-foreground/40"
                        />
                        <p class="text-sm text-muted-foreground">
                            建立後顯示流程紀錄
                        </p>
                    </div>
                {/if}
                {@render sidePanel?.()}
            </div>
        </Sheet.Content>
    </Sheet.Root>
</div>
