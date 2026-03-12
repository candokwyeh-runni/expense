<script lang="ts">
    import { createBrowserSupabaseClient } from "$lib/supabase";
    import { Button } from "$lib/components/ui/button";
    import { onMount } from "svelte";
    import {
        Card,
        CardContent,
        CardDescription,
        CardHeader,
        CardTitle,
    } from "$lib/components/ui/card";

    let authNotice = $state("");

    onMount(() => {
        const reason = new URLSearchParams(window.location.search).get(
            "reason",
        );
        if (reason === "inactive") {
            authNotice = "此帳號已停用，請聯絡管理員協助重新啟用。";
        } else if (reason === "profile_missing") {
            authNotice = "帳號資料異常，請重新登入或聯絡管理員。";
        } else if (reason === "domain_restricted") {
            authNotice = "此網站僅允許公司網域（@runnii.com）登入，請改用公司帳號。";
        } else if (reason === "oauth_failed") {
            authNotice = "登入驗證失敗，請稍後重試；若持續失敗請聯絡管理員。";
        }
    });

    /**
     * 執行 Google OAuth 登入
     */
    async function loginWithGoogle() {
        const supabase = createBrowserSupabaseClient();
        const next = new URLSearchParams(window.location.search).get("next");
        const safeNext = next && next.startsWith("/") && !next.startsWith("//")
            ? next
            : "/";
        const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;

        await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                // 成功後重導向至 Callback 處理路徑
                redirectTo: callbackUrl,
            },
        });
    }
</script>

<div class="flex min-h-screen items-center justify-center bg-muted/40 px-4">
    <div class="mx-auto w-full max-w-[400px]">
        <!-- 品牌識別或系統名稱 -->
        <div class="mb-8 text-center">
            <h2 class="text-3xl font-bold tracking-tight text-primary">
                報銷系統
            </h2>
            <p class="mt-2 text-sm text-muted-foreground">
                Expense Reimbursement System
            </p>
        </div>

        <Card class="border-none shadow-xl">
            <CardHeader class="space-y-1 text-center">
                <CardTitle class="text-2xl">歡迎回來</CardTitle>
                <CardDescription>
                    請使用您的 Google 帳號登入系統
                </CardDescription>
                {#if authNotice}
                    <p
                        class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700"
                    >
                        {authNotice}
                    </p>
                {/if}
            </CardHeader>
            <CardContent class="grid gap-4 pt-4">
                <Button
                    variant="outline"
                    class="h-12 w-full gap-2 text-base transition-all hover:bg-muted"
                    onclick={loginWithGoogle}
                >
                    <svg class="h-5 w-5" viewBox="0 0 24 24">
                        <path
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            fill="#4285F4"
                        />
                        <path
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1 .67-2.28 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            fill="#34A853"
                        />
                        <path
                            d="M5.84 14.09c-.22-.67-.35-1.39-.35-2.09s.13-1.42.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                            fill="#FBBC05"
                        />
                        <path
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            fill="#EA4335"
                        />
                        <path d="M1 1h22v22H1z" fill="none" />
                    </svg>
                    使用 Google 帳號登入
                </Button>

                <div class="relative mt-4">
                    <div class="absolute inset-0 flex items-center">
                        <span class="w-full border-t"></span>
                    </div>
                    <div class="relative flex justify-center text-xs uppercase">
                        <span class="bg-card px-2 text-muted-foreground">
                            SECURE ACCESS
                        </span>
                    </div>
                </div>

                <p
                    class="mt-2 px-8 text-center text-xs leading-relaxed text-muted-foreground"
                >
                    登入即表示您同意系統的服務條款與隱私政策。
                </p>
            </CardContent>
        </Card>
    </div>
</div>

<style>
    /* 可以在此處加入細微的漸層背景效果 */
    :global(body) {
        background-image: radial-gradient(
                at 0% 0%,
                hsla(253, 16%, 7%, 1) 0,
                transparent 50%
            ),
            radial-gradient(
                at 50% 0%,
                hsla(225, 39%, 30%, 1) 0,
                transparent 50%
            ),
            radial-gradient(
                at 100% 0%,
                hsla(339, 49%, 30%, 1) 0,
                transparent 50%
            );
    }
</style>
