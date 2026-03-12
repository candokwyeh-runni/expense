<script lang="ts">
    import { createBrowserSupabaseClient } from "$lib/supabase";
    import { Sparkles } from "lucide-svelte";
    import { fade } from "svelte/transition";

    /**
     * Svelte 5 Props
     */
    let { data } = $props();

    const signInWithGoogle = async () => {
        const supabase = createBrowserSupabaseClient();
        await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: `${window.location.origin}/auth/callback`,
            },
        });
    };

    const { session } = $derived(data);
</script>

{#if !session}
    <div
        class="flex flex-col items-center justify-center min-h-[70vh] space-y-12"
        in:fade={{ duration: 800 }}
    >
        <div class="text-center space-y-8">
            <div
                class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-[10px] font-bold tracking-widest uppercase mb-4"
            >
                <Sparkles class="h-3 w-3" /> Enterprise Solutions
            </div>

            <p
                class="text-muted-foreground text-xl max-w-xl mx-auto leading-relaxed font-medium"
            >
                為企業量身打造的報銷管理系統。<br />讓每一筆支出都能優雅被追蹤。
            </p>
        </div>

        <button
            onclick={signInWithGoogle}
            class="group relative flex items-center justify-center gap-4 bg-foreground text-background px-10 py-4.5 rounded-2xl hover:opacity-90 transition-all font-semibold shadow-xl active:scale-[0.98]"
        >
            <img
                src="https://www.google.com/favicon.ico"
                alt="Google"
                class="w-5 h-5 grayscale brightness-200"
            />
            <span class="text-base">使用企業帳號登入</span>
        </button>
    </div>
{/if}
