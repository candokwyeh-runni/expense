<script lang="ts">
    /**
     * UserProfileSheet.svelte
     *
     * 職責：
     * 1. 顯示並編輯使用者資訊（可用於個人設定或管理員編輯）。
     * 2. 處理銀行帳號的 AES-256 對稱解密與顯示。
     * 3. 透過 SvelteKit Form Actions 同步更新資料庫。
     */
    import { enhance } from "$app/forms";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Separator } from "$lib/components/ui/separator";
    import * as Avatar from "$lib/components/ui/avatar";
    import * as Sheet from "$lib/components/ui/sheet";
    import { toast } from "svelte-sonner";
    import { User, Save, Check, Pencil, X, Camera } from "lucide-svelte";
    import { deserialize, applyAction } from "$app/forms";
    import { untrack } from "svelte";
    import { timedFetch } from "$lib/client/timed-fetch";
    import { page } from "$app/state";
    import { invalidateAll } from "$app/navigation";
    import { browser } from "$app/environment";
    import RoleApproverPanel from "$lib/components/layout/RoleApproverPanel.svelte";
    import BankAccountSection from "$lib/components/layout/BankAccountSection.svelte";
    import { UI_MESSAGES } from "$lib/constants/ui-messages";

    let {
        user,
        open = $bindable(false),
        isManagementMode = false,
        approverOptions = [],
        canEditPermissions = true,
    } = $props();

    let loading = $state(false);
    let savingProfile = $state(false);

    let showAccountValue = $state(false);
    let decryptedAccount = $state<string | null>(null);
    let revealing = $state(false);

    let fullName = $state("");
    let bankName = $state("");
    let inputBankAccount = $state("");
    let isEditing = $state(false);
    let isEditingName = $state(false);
    let isAddingBankAccount = $state(false);
    let avatarInputEl = $state<HTMLInputElement | null>(null);
    let avatarUploading = $state(false);
    let isAdmin = $state(false);
    let isFinance = $state(false);
    let approverId = $state("");
    let initializedUserId = $state<string | null>(null);
    const roleApproverHelperText = "角色與核准人由管理員設定。";

    function resetFormFromUser() {
        fullName = user?.full_name || user?.name || "";
        bankName = user?.bank || "";
        inputBankAccount = "";
        isAdmin = user?.is_admin || user?.isAdmin || false;
        isFinance = user?.is_finance || user?.isFinance || false;
        approverId = user?.approver_id || "";
        isEditingName = false;
        isAddingBankAccount = false;
        showAccountValue = false;
        decryptedAccount = null;
    }

    async function refreshUserSnapshot() {
        if (!open || !user?.id) return;

        try {
            const formData = new FormData();
            if (isManagementMode) {
                formData.append("targetId", user.id);
            }

            const actionPath = isManagementMode
                ? "/admin/users?/getUserProfileSnapshot"
                : "/account?/getMyProfileSnapshot";

            const response = await timedFetch(actionPath, {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const text = await response.text();
            const result = deserialize(text) as any;

            if (
                response.ok &&
                result?.type === "success" &&
                result?.data?.profile
            ) {
                const incomingProfile = result.data.profile as Record<
                    string,
                    unknown
                >;
                if (isManagementMode) {
                    // admin 編輯：直接以後端回傳值為準，不做 null 卡控
                    user = { ...user, ...incomingProfile };
                } else {
                    // 自行編輯：後端快照偶發回 null 時，保留目前畫面已有值
                    user = {
                        ...user,
                        ...incomingProfile,
                        bank:
                            typeof incomingProfile.bank === "string"
                                ? incomingProfile.bank
                                : (user?.bank ?? ""),
                        bank_account_tail:
                            typeof incomingProfile.bank_account_tail ===
                            "string"
                                ? incomingProfile.bank_account_tail
                                : (user?.bank_account_tail ??
                                  user?.bankAccountTail ??
                                  ""),
                        bankAccountTail:
                            typeof incomingProfile.bank_account_tail ===
                            "string"
                                ? incomingProfile.bank_account_tail
                                : (user?.bankAccountTail ??
                                  user?.bank_account_tail ??
                                  ""),
                    };
                }
                if (!isEditing && !savingProfile) {
                    resetFormFromUser();
                }
            }
        } catch {
            // 保持目前畫面資料，不中斷使用者操作
        }
    }

    const currentUserId = $derived(
        page.data.currentUserId || page.data.session?.user?.id,
    );
    const currentUserEmail = $derived(page.data.session?.user?.email);

    const isSelf = $derived(
        user?.id === currentUserId ||
            (user?.email &&
                currentUserEmail &&
                user.email === currentUserEmail),
    );

    const maskedAccountTail = $derived.by(() => {
        const rawTail = String(
            user?.bank_account_tail || user?.bankAccountTail || "",
        ).trim();
        if (!rawTail) return "";
        return `*****${rawTail.slice(-5)}`;
    });

    const hasBankInfo = $derived.by(
        () =>
            Boolean(String(user?.bank || "").trim()) ||
            Boolean(
                String(
                    user?.bank_account_tail || user?.bankAccountTail || "",
                ).trim(),
            ),
    );

    const approverName = $derived.by(() => {
        const found = approverOptions.find(
            (o) => o.id === approverId,
        )?.full_name;
        if (found) return found;
        return user?.approver_name || user?.approver?.full_name || "(無)";
    });

    $effect(() => {
        if (!user?.id) return;

        if (initializedUserId !== user.id) {
            initializedUserId = user.id;
            resetFormFromUser();
            isEditing = false;
            return;
        }

        if (!isEditing && !savingProfile) {
            resetFormFromUser();
        }
    });

    $effect(() => {
        if (!open && user) {
            resetFormFromUser();
            isEditing = false;
        }
    });

    $effect(() => {
        if (!browser) return;
        if (open) {
            void untrack(() => refreshUserSnapshot());
        }
    });

    function handleResult() {
        return async ({ result }: { result: any }) => {
            loading = false;
            if (result.type === "success") {
                toast.success(
                    isManagementMode
                        ? UI_MESSAGES.user.profileUpdated
                        : UI_MESSAGES.user.selfProfileUpdated,
                );
                await applyAction(result);
                if (isManagementMode) {
                    await invalidateAll();
                }
                decryptedAccount = null;
                showAccountValue = false;
                if (isManagementMode) open = false;
            } else if (result.type === "failure") {
                toast.error(
                    result.data?.message || UI_MESSAGES.common.updateFailed,
                );
            }
        };
    }

    async function startEditing() {
        isEditing = true;

        if (isManagementMode && !approverId) {
            const fallbackApprover = approverOptions.find(
                (o) => o.id !== user.id,
            );
            if (fallbackApprover) {
                approverId = fallbackApprover.id;
            }
        }

        if (!decryptedAccount) {
            await toggleReveal();
        } else {
            showAccountValue = true;
        }
    }

    function cancelEditing() {
        isEditing = false;
        resetFormFromUser();
    }

    function startNameEditing() {
        fullName = user?.full_name || user?.name || "";
        isEditingName = true;
    }

    function cancelNameEditing() {
        isEditingName = false;
        fullName = user?.full_name || user?.name || "";
    }

    async function submitSelfProfileUpdate(
        formData: FormData,
        optimistic?: () => void,
    ) {
        loading = true;
        savingProfile = true;
        try {
            const response = await timedFetch("/account?/updateProfile", {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const text = await response.text();
            const result = deserialize(text) as any;

            if (response.ok && result?.type === "success") {
                optimistic?.();
                await applyAction(result);
                toast.success(UI_MESSAGES.user.selfProfileUpdated);
                await invalidateAll();
                await refreshUserSnapshot();
                return true;
            }

            toast.error(
                result?.data?.message || UI_MESSAGES.common.updateFailed,
            );
            return false;
        } catch {
            toast.error(UI_MESSAGES.common.updateFailed);
            return false;
        } finally {
            loading = false;
            savingProfile = false;
        }
    }

    function triggerAvatarPicker() {
        avatarInputEl?.click();
    }

    async function uploadAvatar(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        avatarUploading = true;
        try {
            const formData = new FormData();
            formData.append("avatar", file);

            const response = await timedFetch("/account?/updateAvatar", {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const text = await response.text();
            const result = deserialize(text) as any;

            if (response.ok && result?.type === "success") {
                const avatarUrl = String(result?.data?.avatarUrl || "");
                if (avatarUrl) {
                    user = { ...user, avatar_url: avatarUrl, avatarUrl };
                }
                toast.success("頭像已更新");
                await applyAction(result);
                await invalidateAll();
                await refreshUserSnapshot();
            } else {
                toast.error(
                    result?.data?.message || UI_MESSAGES.common.updateFailed,
                );
            }
        } catch {
            toast.error(UI_MESSAGES.common.updateFailed);
        } finally {
            avatarUploading = false;
            input.value = "";
        }
    }

    async function saveSelfName() {
        const trimmed = fullName.trim();
        if (!trimmed) {
            toast.error(UI_MESSAGES.user.nameRequired);
            return;
        }
        const formData = new FormData();
        formData.append("fullName", trimmed);

        const ok = await submitSelfProfileUpdate(formData, () => {
            user = { ...user, full_name: trimmed, name: trimmed };
            isEditingName = false;
        });
        if (!ok) return;
    }

    function startAddingBankAccount() {
        bankName = user?.bank || "";
        inputBankAccount = "";
        decryptedAccount = null;
        showAccountValue = false;
        isAddingBankAccount = true;
    }

    function cancelAddingBankAccount() {
        isAddingBankAccount = false;
        bankName = user?.bank || "";
        inputBankAccount = "";
        decryptedAccount = null;
        showAccountValue = false;
    }

    async function saveSelfBankAccount() {
        const bank = bankName.trim();
        const account = inputBankAccount.trim();
        if (!bank || !account) {
            toast.error(UI_MESSAGES.user.bankFieldsRequired);
            return;
        }

        loading = true;
        savingProfile = true;
        try {
            const formData = new FormData();
            formData.append("bank", bank);
            formData.append("bankAccount", account);

            const response = await timedFetch("/account?/updateProfile", {
                method: "POST",
                body: formData,
                headers: { "x-sveltekit-action": "true" },
            });
            const text = await response.text();
            const result = deserialize(text) as any;

            if (response.ok && result?.type === "success") {
                // 立即做本地快照同步
                const tail = account.length <= 5 ? account : account.slice(-5);
                user = {
                    ...user,
                    bank,
                    bank_account_tail: tail,
                    bankAccountTail: tail,
                };
                isAddingBankAccount = false;
                inputBankAccount = "";
                showAccountValue = false;
                decryptedAccount = null;

                toast.success(UI_MESSAGES.user.selfProfileUpdated);

                // 僅刷新快照，不呼叫 invalidateAll() 以避免觸發
                // parent 重新推送 user prop 導致 hasBankInfo 短暫歸零
                await refreshUserSnapshot();
                return;
            }

            toast.error(
                result?.data?.message || UI_MESSAGES.common.updateFailed,
            );
        } catch {
            toast.error(UI_MESSAGES.common.updateFailed);
        } finally {
            loading = false;
            savingProfile = false;
        }
    }

    async function toggleReveal() {
        if (!isManagementMode && isAddingBankAccount) {
            showAccountValue = !showAccountValue;
            return;
        }

        // Hide first: ensure the field can always be masked again.
        if (showAccountValue) {
            showAccountValue = false;
            return;
        }

        if (!decryptedAccount) {
            revealing = true;
            try {
                const formData = new FormData();
                if (isManagementMode) {
                    formData.append("targetId", user.id);
                }

                const actionPath = isManagementMode
                    ? "/admin/users?/revealUserBankAccount"
                    : "/account?/revealAccount";

                const response = await timedFetch(actionPath, {
                    method: "POST",
                    body: formData,
                    headers: { "x-sveltekit-action": "true" },
                });
                const text = await response.text();
                const result = deserialize(text) as any;

                if (
                    result.type === "success" &&
                    result.data &&
                    "decryptedAccount" in result.data
                ) {
                    const raw = result.data.decryptedAccount;
                    decryptedAccount =
                        raw != null && String(raw) !== "null"
                            ? String(raw)
                            : "";
                    if (
                        isManagementMode &&
                        isEditing &&
                        !inputBankAccount.trim() &&
                        decryptedAccount
                    ) {
                        inputBankAccount = decryptedAccount;
                    }
                } else {
                    toast.error(UI_MESSAGES.user.accountReadFailed);
                    return;
                }
            } catch {
                toast.error(UI_MESSAGES.user.accountReadFailed);
                return;
            } finally {
                revealing = false;
            }
        }
        showAccountValue = true;
    }
</script>

<Sheet.Root bind:open>
    <Sheet.Content class="sm:max-w-sm overflow-y-auto">
        <Sheet.Header>
            <Sheet.Title
                >{isManagementMode ? "編輯使用者" : "個人帳戶設定"}</Sheet.Title
            >
            <Sheet.Description>
                {isManagementMode
                    ? "管理使用者的基本資訊、全域權限與核准流程。"
                    : "管理您的個人資訊與匯款帳號。變更將立即套用於系統。"}
            </Sheet.Description>
        </Sheet.Header>

        <div class="mt-4 space-y-4 pb-4">
            <div class="flex flex-col items-center gap-4">
                <div class="relative">
                    <Avatar.Root
                        class="h-16 w-16 border-2 border-background shadow-md"
                    >
                        {#if user.avatar_url || user.avatarUrl}
                            <Avatar.Image
                                src={user.avatar_url || user.avatarUrl}
                                alt={user.full_name || user.name}
                            />
                        {/if}
                        <Avatar.Fallback
                            class="bg-primary/5 text-2xl text-primary font-bold"
                        >
                            {(user.full_name || user.name || "?")
                                .charAt(0)
                                .toUpperCase()}
                        </Avatar.Fallback>
                    </Avatar.Root>
                    {#if !isManagementMode && isSelf}
                        <input
                            bind:this={avatarInputEl}
                            type="file"
                            class="hidden"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            onchange={uploadAvatar}
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="secondary"
                            class="absolute -right-1 -bottom-1 h-7 w-7 rounded-full shadow-sm"
                            onclick={triggerAvatarPicker}
                            disabled={avatarUploading || loading}
                            aria-label={avatarUploading
                                ? "頭像上傳中"
                                : "編輯頭像"}
                            title={avatarUploading
                                ? "頭像上傳中..."
                                : "更換頭像"}
                        >
                            <Camera class="h-3.5 w-3.5" />
                        </Button>
                    {/if}
                </div>

                <div class="text-center w-full px-4">
                    {#if !isManagementMode && isSelf}
                        {#if isEditingName}
                            <div class="flex items-center justify-center gap-2">
                                <Input
                                    name="fullName"
                                    bind:value={fullName}
                                    class="text-center text-lg font-semibold h-9 bg-muted/50 border-primary/20 focus:bg-background transition-colors"
                                    placeholder="請輸入姓名"
                                    required
                                />
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label="儲存姓名"
                                    onclick={saveSelfName}
                                    disabled={loading}
                                >
                                    <Check class="h-4 w-4 text-primary" />
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    aria-label="取消姓名編輯"
                                    onclick={cancelNameEditing}
                                    disabled={loading}
                                >
                                    <X class="h-4 w-4 text-muted-foreground" />
                                </Button>
                            </div>
                        {:else}
                            <div class="flex items-center justify-center gap-2">
                                <h3 class="text-lg font-semibold">
                                    {user.full_name || user.name}
                                </h3>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    class="h-8 w-8 p-0"
                                    onclick={startNameEditing}
                                    aria-label="編輯姓名"
                                >
                                    <Pencil class="h-4 w-4" />
                                </Button>
                            </div>
                        {/if}
                    {:else}
                        <h3 class="text-lg font-semibold">
                            {user.full_name || user.name}
                        </h3>
                    {/if}

                    <p class="text-sm text-muted-foreground">{user.email}</p>
                </div>
            </div>

            <Separator />

            {#if isManagementMode}
                <form
                    method="POST"
                    action="/admin/users?/updateUserProfile"
                    use:enhance={() => {
                        loading = true;
                        return handleResult();
                    }}
                    class="space-y-4"
                >
                    <input type="hidden" name="userId" value={user.id} />

                    <RoleApproverPanel
                        editable={true}
                        {isEditing}
                        bind:isAdmin
                        bind:isFinance
                        bind:approverId
                        {approverOptions}
                        currentUserId={user.id}
                        helperText={roleApproverHelperText}
                        allowRoleEdit={canEditPermissions}
                    />

                    <input type="hidden" name="isAdminValue" value={isAdmin} />
                    <input
                        type="hidden"
                        name="isFinanceValue"
                        value={isFinance}
                    />

                    <Separator />

                    <BankAccountSection
                        mode="management"
                        {isEditing}
                        bind:bankName
                        bind:inputBankAccount
                        {maskedAccountTail}
                        {decryptedAccount}
                        {showAccountValue}
                        {revealing}
                        onToggleReveal={toggleReveal}
                    />

                    <div
                        class="pt-2 sticky bottom-0 bg-background/80 backdrop-blur-sm pb-2 flex flex-col gap-2"
                    >
                        {#if isEditing}
                            <div class="flex flex-row gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    class="flex-1"
                                    onclick={cancelEditing}
                                >
                                    取消編輯
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={loading}
                                    class="flex-1 gap-2 shadow-lg"
                                >
                                    {#if loading}
                                        <span
                                            class="animate-spin h-4 w-4 border-2 border-background border-t-transparent rounded-full"
                                        ></span>
                                    {:else}
                                        <Save class="h-4 w-4" />
                                    {/if}
                                    儲存變更
                                </Button>
                            </div>
                        {:else}
                            <Button
                                type="button"
                                class="w-full gap-2 shadow-lg"
                                onclick={startEditing}
                            >
                                <User class="h-4 w-4" />
                                編輯個人資訊
                            </Button>
                        {/if}
                    </div>
                </form>
            {:else}
                <div class="space-y-4">
                    <RoleApproverPanel
                        editable={false}
                        {isAdmin}
                        {isFinance}
                        {approverName}
                        helperText={roleApproverHelperText}
                    />

                    <Separator />

                    <BankAccountSection
                        mode="self"
                        {isAddingBankAccount}
                        {hasBankInfo}
                        bind:bankName
                        bind:inputBankAccount
                        {maskedAccountTail}
                        {decryptedAccount}
                        {showAccountValue}
                        {revealing}
                        {loading}
                        onToggleReveal={toggleReveal}
                        onStartAddingBankAccount={startAddingBankAccount}
                        onCancelAddingBankAccount={cancelAddingBankAccount}
                        onSaveAddingBankAccount={saveSelfBankAccount}
                    />
                </div>
            {/if}
        </div>
    </Sheet.Content>
</Sheet.Root>
