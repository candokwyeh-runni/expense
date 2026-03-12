/**
 * SvelteKit 伺服器端攔截器 (Server Hooks)
 * 
 * 職責：
 * 1. 攔截每一筆傳入的伺服器端請求。
 * 2. 初始化 Supabase 認證狀態。
 * 3. 未來可擴充：路由保護、日誌記錄、效能監控。
 */
import { supabaseHandle } from '$lib/supabase';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle } from '@sveltejs/kit';

function isRequestAbortError(error: unknown): boolean {
    const text = String(
        (error as any)?.message ||
        (error as any)?.cause?.message ||
        error ||
        ''
    ).toLowerCase();
    return text === 'aborted' || text.includes('request aborted');
}

const timingHandle: Handle = async ({ event, resolve }) => {
    const start = performance.now();
    let response: Response;
    try {
        response = await resolve(event);
    } catch (error) {
        if (isRequestAbortError(error)) {
            return new Response(null, { status: 499 });
        }
        throw error;
    }
    const elapsedMs = performance.now() - start;
    const elapsed = `${elapsedMs.toFixed(1)}ms`;

    response.headers.set('x-response-time', elapsed);
    response.headers.set('server-timing', `app;dur=${elapsedMs.toFixed(1)}`);

    const isApiLikeRequest =
        event.url.pathname.startsWith('/api') ||
        event.request.headers.get('x-sveltekit-action') === 'true';
    if (isApiLikeRequest) {
        console.info(`[API-TIME] ${event.request.method} ${event.url.pathname} ${elapsed}`);
    }

    return response;
};

/**
 * 認證與權限控制攔截器 (Auth & RBAC Hook)
 */
const authHandle: Handle = async ({ event, resolve }) => {
    const session = await event.locals.getSession();
    const { pathname } = event.url;

    // 1. 公開頁面不需要驗證
    const isPublicRoute =
        pathname === '/' ||
        pathname.startsWith('/auth') ||
        pathname === '/api/notify/drain';

    if (!isPublicRoute && !session) {
        // 未登入使用者存取私有頁面，重導向至登入頁
        throw redirect(303, `/auth?next=${pathname}`);
    }

    // 2. 獲取使用者角色 (RBAC)
    if (session) {
        const { data: profile } = await event.locals.supabase
            .from('profiles')
            .select('is_admin, is_finance, is_active')
            .eq('id', session.user.id)
            .single();

        if (!profile) {
            await event.locals.supabase.auth.signOut();
            if (!pathname.startsWith('/auth')) {
                throw redirect(303, '/auth?reason=profile_missing');
            }
            return resolve(event);
        }

        if (profile.is_active === false) {
            await event.locals.supabase.auth.signOut();
            if (!pathname.startsWith('/auth')) {
                throw redirect(303, '/auth?reason=inactive');
            }
            return resolve(event);
        }

        // 2-1. 已登入且啟用中的使用者不應存取登入頁
        if (pathname === '/auth') {
            throw redirect(303, '/');
        }

        // 注入到 event.locals 供各頁面輕易存取
        event.locals.user = {
            ...session.user,
            is_admin: profile?.is_admin ?? false,
            is_finance: profile?.is_finance ?? false,
            is_active: profile?.is_active ?? true
        };

        // 3. 行政/管理路由保護
        // /admin/users 同時允許 admin 與 finance 進入（實際可執行操作由各 action 再細分）
        const canAccessAdminUsers = pathname.startsWith('/admin/users') &&
            (event.locals.user.is_admin || event.locals.user.is_finance);
        if (pathname.startsWith('/admin') && !event.locals.user.is_admin && !canAccessAdminUsers) {
            throw redirect(303, '/');
        }

        // 4. 財務路由保護
        if (pathname.startsWith('/finance') && !event.locals.user.is_finance) {
            throw redirect(303, '/');
        }
    }

    return resolve(event);
};

/**
 * Handle 入口函數
 * 
 * 使用 sequence 方法來串聯多個處理器：
 * - supabaseHandle: 處理 Supabase 客戶端初始化與 Cookie/Session 同步。
 * 
 * 執行流程：
 * Request → sequence(supabaseHandle) → Route Handler (+page.server.ts 等) → sequence(supabaseHandle) → Response
 */
export const handle = sequence(timingHandle, supabaseHandle, authHandle);
