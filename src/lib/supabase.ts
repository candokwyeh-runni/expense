/**
 * Supabase 客戶端配置中心
 * 
 * 職責：
 * 1. 初始化 Supabase 用戶端 (SSR 模式)。
 * 2. 處理瀏覽器端與伺服器端的連線差異。
 * 3. 實作 SvelteKit 的 Handle 攔截器，確保 Session 與瀏覽器 Cookie 自動同步。
 */
import { createBrowserClient, createServerClient, parseCookieHeader } from '@supabase/ssr';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';
import type { Handle } from '@sveltejs/kit';

/**
 * 建立「瀏覽器端」使用的 Supabase Client
 * 
 * 特色：
 * - 在客戶端運行時(如 +page.svelte)呼叫。
 * - 自動利用瀏覽器的 fetch 與 cookie。
 */
export const createBrowserSupabaseClient = () =>
    createBrowserClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY);

/**
 * SvelteKit 伺服器端攔截器 (用於 hooks.server.ts)
 * 
 * 職責：
 * - 為每個傳入的請求建立一個新的 Server-side Supabase Client。
 * - getAll: 從請求標頭中讀取現有的 Cookie，傳遞給 Supabase 識別身分。
 * - setAll: 當 Supabase 更新 Session (如 Refresh Token) 時，將新的 Cookie 寫回回應標頭，同步到瀏覽器。
 * - 注入 event.locals: 讓後續的 Load 函數能直接透過 event.locals.supabase 存取資料庫。
 */
export const supabaseHandle: Handle = async ({ event, resolve }) => {
    // 初始化伺服器端客戶端
    event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
        cookies: {
            // 讀取請求中所有的 Cookie
            getAll() {
                return parseCookieHeader(event.request.headers.get('cookie') ?? '').map((c) => ({
                    name: c.name,
                    value: c.value ?? ''
                }));
            },
            // 設定新的 Cookie 到 SvelteKit 的回應中
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value, options }) =>
                    event.cookies.set(name, value, { ...options, path: '/' })
                );
            },
        },
    });

    /**
     * 輔助函數：供所有伺服器端 Load 函數獲取當前 Session
     *
     * 安全注意事項：
     * - auth.getSession() 僅從本地儲存讀取，不做伺服器端驗證，可能被竄改。
     * - auth.getUser() 會向 Supabase Auth Server 發送請求驗證 JWT，確保安全。
     * - 伺服器端應優先使用 getUser() 確認身分後，再用 getSession() 取得 token 資訊。
     */
    let sessionPromise: Promise<any> | null = null;
    event.locals.getSession = async () => {
        if (sessionPromise) return sessionPromise;

        sessionPromise = (async () => {
            const {
                data: { user },
                error: userError,
            } = await event.locals.supabase.auth.getUser();

            if (!user) {
                // If getUser() failed due to a transient error (rate limit / network),
                // fall back to the local JWT session to avoid incorrect auth redirects.
                if (userError) {
                    const isTransient =
                        userError.status === 429 ||
                        /rate limit|over_request_rate_limit|fetch failed|network|timed out/i.test(
                            String(userError.message || '')
                        );
                    if (isTransient) {
                        console.warn('[auth] getUser() transient failure, falling back to getSession():', userError.message);
                        const { data: { session } } = await event.locals.supabase.auth.getSession();
                        return session;
                    }
                }
                return null;
            }

            const {
                data: { session },
            } = await event.locals.supabase.auth.getSession();
            return session;
        })();

        return sessionPromise;
    };

    /**
     * 執行頁面邏輯
     * filterSerializedResponseHeaders: 確保正確處理分頁請求的 Content-Range 標頭
     */
    return resolve(event, {
        filterSerializedResponseHeaders(name) {
            return name === 'content-range';
        },
    });
};
