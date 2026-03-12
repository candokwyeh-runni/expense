<!--
  +layout.svelte - 全域共用版面 (Root Layout)
  
  職責：
  1. 載入全域樣式 (Tailwind CSS)。
  2. 管理全域狀態與生命週期。
  3. 處理 Supabase 認證狀態同步（瀏覽器與伺服器端）。
  4. 定義共用的 UI 框架結構（如 Sidebar 與 Main Content 區域）。
-->
<script lang="ts">
	// 引入全域 CSS (Tailwind, shadcn 變數)
	import "../app.css";
	import { invalidate } from "$app/navigation";
	import { createBrowserSupabaseClient } from "$lib/supabase";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { browser } from "$app/environment";
	import { Toaster } from "svelte-sonner";
	import Sidebar from "$lib/components/layout/Sidebar.svelte";
	import { Menu, X } from "lucide-svelte";
	import type { LayoutData } from "./$types";

	// 接收來自 +layout.server.ts 的資料 (data) 及其子頁面 (children)
	let { data, children }: { data: LayoutData; children: any } = $props();

	/**
	 * 生命週期：掛載時執行
	 */
	onMount(() => {
		if (!browser) return;
		const supabase = createBrowserSupabaseClient();
		const {
			data: { subscription },
		} = supabase.auth.onAuthStateChange((event, _session) => {
			if (_session?.expires_at !== data.session?.expires_at) {
				invalidate("supabase:auth");
			}
		});

		return () => subscription.unsubscribe();
	});

	// 判斷是否為認證相關頁面 (例如登入頁)
	const isAuthPage = $derived(page.url.pathname.startsWith("/auth"));

	// 從 Session 與 Profile 中提取使用者資訊供 Sidebar 使用
	const sidebarUser = $derived(
		data.session
			? {
					name:
						data.profile?.full_name ||
						data.session.user.user_metadata.full_name ||
						data.session.user.email?.split("@")[0] ||
						"User",
					email: data.session.user.email || "",
					avatarUrl:
						data.profile?.avatar_url ||
						data.session.user.user_metadata.avatar_url,
					isFinance: data.profile?.is_finance ?? false,
					isAdmin: data.profile?.is_admin ?? false,
					isApprover: data.profile?.is_approver ?? false,
					approver_id: data.profile?.approver_id || "",
					approver_name: data.profile?.approver_name || "",
					bank: data.profile?.bank || "",
					bankAccountTail: data.profile?.bank_account_tail || "",
					myClaimsPendingCount:
						data.pendingCounters?.myClaimsActionRequired || 0,
					approvalPendingCount:
						data.pendingCounters?.approvalPendingTotal || 0,
					payeePendingCount:
						data.pendingCounters?.payeePendingTotal || 0,
				}
			: null,
	);

	let mobileNavOpen = $state(false);

	$effect(() => {
		page.url.pathname;
		mobileNavOpen = false;
	});
</script>

<Toaster />

{#if data.session && !isAuthPage && sidebarUser}
	<!-- 已登入且不在登入頁：顯示側邊欄佈局 -->
	<div
		class="flex min-h-screen bg-secondary/50 text-foreground transition-all duration-300"
		style="--sidebar-w: 16rem; --sidebar-gap: 0rem;"
	>
		<button
			type="button"
			class="fixed top-4 left-4 z-[70] inline-flex h-10 w-10 items-center justify-center rounded-lg border bg-background/95 text-foreground shadow-sm md:hidden"
			aria-label={mobileNavOpen ? "關閉選單" : "開啟選單"}
			onclick={() => (mobileNavOpen = !mobileNavOpen)}
		>
			{#if mobileNavOpen}
				<X class="h-5 w-5" />
			{:else}
				<Menu class="h-5 w-5" />
			{/if}
		</button>

		{#if mobileNavOpen}
			<button
				type="button"
				class="fixed inset-0 z-40 bg-black/30 md:hidden"
				aria-label="關閉側邊欄"
				onclick={() => (mobileNavOpen = false)}
			></button>
		{/if}

		<Sidebar
			user={sidebarUser}
			class={mobileNavOpen
				? "translate-x-0"
				: "-translate-x-full md:translate-x-0"}
		/>
		<main class="flex-1 md:ml-[calc(var(--sidebar-w)+var(--sidebar-gap))] min-h-screen overflow-x-hidden">
			<div class="max-w-7xl mx-auto p-6 lg:p-10 space-y-8">
				{@render children()}
			</div>
		</main>
	</div>
{:else}
	<!-- 未登入或在登入頁：顯示純內容 (例如登入表單) -->
	<div class="min-h-screen bg-background">
		{@render children()}
	</div>
{/if}
