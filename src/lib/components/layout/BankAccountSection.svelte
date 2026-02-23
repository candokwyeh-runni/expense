<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import BankCodeCombobox from "$lib/components/layout/BankCodeCombobox.svelte";
    import { Check, CreditCard, Eye, EyeOff, X } from "lucide-svelte";

    let {
        mode = "management" as "management" | "self" | "payee",
        isEditing = false,
        isFinance = false,
        isAddingBankAccount = false,
        hasBankInfo = true,
        showTitle = true,
        viewOnlyFieldClass = "",
        bankName = $bindable(""),
        inputBankAccount = $bindable(""),
        maskedAccountTail = "",
        decryptedAccount = null as string | null,
        showAccountValue = false,
        revealing = false,
        onToggleReveal = (() => {}) as () => void | Promise<void>,
        onStartAddingBankAccount = (() => {}) as () => void,
        onCancelAddingBankAccount = (() => {}) as () => void,
        onSaveAddingBankAccount = (() => {}) as () => void | Promise<void>,
        loading = false,
    } = $props();

    const isManagement = $derived(mode === "management");
    const isPayee = $derived(mode === "payee");
    const canEdit = $derived(
        isManagement ? isEditing : isPayee ? isEditing : isAddingBankAccount,
    );
    const bankCodeFieldId = $derived(
        isManagement ? "bank" : isPayee ? "bank_code" : "self-bank",
    );
    const bankCodeFieldName = $derived(
        isManagement ? "bankName" : isPayee ? "bank_code" : "bank",
    );
    const bankAccountFieldId = $derived(
        isManagement
            ? "bankAccount"
            : isPayee
              ? "bank_account"
              : "self-bankAccount",
    );
    const bankAccountFieldName = $derived(
        isPayee ? "bank_account" : "bankAccount",
    );
    const canReveal = $derived(
        isManagement ? true : isPayee ? isFinance : true,
    );
    const helperText = $derived(
        isPayee
            ? "唯有財務人員可查看原始帳號。"
            : "銀行資訊均經 AES-256 對稱加密儲存，除新增外僅管理員可修改銀行資訊。",
    );
</script>

<div class="space-y-3">
    {#if showTitle}
        <div class="flex items-center gap-2 text-sm font-semibold">
            <CreditCard class="h-4 w-4 text-primary" />
            匯款帳號資訊
        </div>
    {/if}

    {#if isManagement || hasBankInfo || isAddingBankAccount}
        <div class="flex gap-4">
            <div class="flex-[2.3] space-y-2 min-w-0">
                <Label for={bankCodeFieldId}>銀行代碼</Label>
                {#if isPayee && !canEdit}
                    <Input
                        id={bankCodeFieldId}
                        type="text"
                        value={bankName}
                        readonly
                        class={viewOnlyFieldClass}
                    />
                {:else}
                    <BankCodeCombobox
                        id={bankCodeFieldId}
                        name={bankCodeFieldName}
                        required={canEdit && (isManagement || isPayee)}
                        disabled={!canEdit}
                        bind:value={bankName}
                        submitMode="code-name"
                    />
                {/if}
            </div>
            <div class="flex-[2.7] space-y-2 min-w-0">
                <Label for={bankAccountFieldId}>銀行帳號</Label>
                <div class="relative">
                    {#if isManagement && isEditing}
                        <Input
                            id={bankAccountFieldId}
                            name={bankAccountFieldName}
                            type={showAccountValue ? "text" : "password"}
                            value={inputBankAccount}
                            oninput={(e: Event) => {
                                const input =
                                    e.currentTarget as HTMLInputElement;
                                input.value = input.value.replace(/[^\d]/g, "");
                                inputBankAccount = input.value;
                            }}
                            inputmode="numeric"
                            placeholder={showAccountValue
                                ? decryptedAccount || "請輸入新帳號..."
                                : "••••••••••••"}
                            disabled={revealing}
                        />
                    {:else if isPayee && isEditing}
                        <Input
                            id={bankAccountFieldId}
                            name={bankAccountFieldName}
                            type={showAccountValue ? "text" : "password"}
                            value={inputBankAccount}
                            oninput={(e: Event) => {
                                const input =
                                    e.currentTarget as HTMLInputElement;
                                input.value = input.value.replace(/[^\d]/g, "");
                                inputBankAccount = input.value;
                            }}
                            inputmode="numeric"
                            placeholder={showAccountValue
                                ? decryptedAccount || "請輸入新帳號..."
                                : maskedAccountTail || "••••••••••••"}
                            disabled={revealing}
                            required
                        />
                    {:else if !isManagement && isAddingBankAccount}
                        <Input
                            id={bankAccountFieldId}
                            name={bankAccountFieldName}
                            type={showAccountValue ? "text" : "password"}
                            value={inputBankAccount}
                            oninput={(e: Event) => {
                                const input =
                                    e.currentTarget as HTMLInputElement;
                                input.value = input.value.replace(/[^\d]/g, "");
                                inputBankAccount = input.value;
                            }}
                            inputmode="numeric"
                            placeholder={showAccountValue
                                ? inputBankAccount || "請輸入銀行帳號"
                                : "••••••••••••"}
                            disabled={revealing}
                        />
                    {:else}
                        <Input
                            id={bankAccountFieldId}
                            type="text"
                            value={showAccountValue
                                ? decryptedAccount || maskedAccountTail
                                : maskedAccountTail || "••••••••••••"}
                            readonly
                            class={viewOnlyFieldClass ||
                                (isManagement ? "pointer-events-none" : "")}
                        />
                    {/if}

                    {#if !canReveal}
                        <span
                            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70 pointer-events-none"
                            aria-hidden="true"
                        >
                            <Eye class="h-4 w-4" />
                        </span>
                    {:else}
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            class="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                            onclick={() => void onToggleReveal()}
                            disabled={revealing}
                            aria-label={showAccountValue
                                ? "隱藏銀行帳號"
                                : "顯示銀行帳號"}
                        >
                            {#if revealing}
                                <span
                                    class="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full"
                                ></span>
                            {:else if showAccountValue}
                                <Eye class="h-4 w-4 text-muted-foreground" />
                            {:else}
                                <EyeOff class="h-4 w-4 text-muted-foreground" />
                            {/if}
                        </Button>
                    {/if}
                </div>
                {#if isPayee && !isFinance}
                    <p class="text-[0.65rem] text-muted-foreground mt-1">
                        {helperText}
                    </p>
                {/if}
            </div>
        </div>
    {:else}
        <div class="rounded-md border border-dashed p-4 space-y-2">
            <p class="text-sm text-muted-foreground">尚未設定銀行帳號</p>
            <Button
                type="button"
                variant="outline"
                onclick={onStartAddingBankAccount}
            >
                新增銀行帳號
            </Button>
        </div>
    {/if}

    {#if !isPayee}
        <p class="text-[0.7rem] text-muted-foreground leading-relaxed">
            {helperText}
        </p>
    {/if}

    {#if !isManagement && isAddingBankAccount}
        <div class="flex items-center justify-end gap-2 pt-1">
            <Button
                type="button"
                variant="ghost"
                size="icon"
                onclick={onCancelAddingBankAccount}
                disabled={loading}
                aria-label="取消新增銀行帳號"
            >
                <X class="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                onclick={onSaveAddingBankAccount}
                disabled={loading}
                aria-label="儲存銀行帳號"
            >
                <Check class="h-4 w-4 text-primary" />
            </Button>
        </div>
    {/if}
</div>
