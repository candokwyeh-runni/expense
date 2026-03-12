/**
 * Playwright 測試共用工具
 * 
 * 職責：
 * 1. 統一載入環境變數
 * 2. 提供 Supabase Admin Client
 * 3. 提供 injectSession() 輔助函數，消除各測試中重複的登入邏輯
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { stringToBase64URL } from '@supabase/ssr/dist/module/utils/base64url.js';
import { createChunks } from '@supabase/ssr/dist/module/utils/chunker.js';

// 載入環境變數
const envConfig = dotenv.parse(readFileSync('.env'));
export const supabaseUrl = envConfig.PUBLIC_SUPABASE_URL;
export const supabaseAnonKey = envConfig.PUBLIC_SUPABASE_ANON_KEY;
export const supabaseServiceKey = envConfig.SUPABASE_SERVICE_ROLE_KEY;

// 從 Supabase URL 動態擷取 project ref（取代 hardcoded 值）
export const projectRef = new URL(supabaseUrl).hostname.split('.')[0];

// Service Role Admin Client
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableNetworkError(error: unknown) {
    const text = String(
        (error as any)?.message ||
            (error as any)?.cause?.message ||
            error ||
            "",
    ).toLowerCase();
    return (
        text.includes("enotfound") ||
        text.includes("eai_again") ||
        text.includes("fetch failed") ||
        text.includes("network") ||
        text.includes("timed out")
    );
}

export async function withNetworkRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 5,
) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!isRetryableNetworkError(error) || attempt === maxAttempts) {
                throw error;
            }
            const backoffMs = Math.min(8000, 400 * Math.pow(2, attempt - 1));
            const jitterMs = Math.floor(Math.random() * 300);
            await sleep(backoffMs + jitterMs);
        }
    }
    throw lastError;
}

const authAdmin = supabaseAdmin.auth.admin;
const rawCreateUser = authAdmin.createUser.bind(authAdmin);
const rawDeleteUser = authAdmin.deleteUser.bind(authAdmin);
const rawListUsers = authAdmin.listUsers.bind(authAdmin);

async function cleanupTestUserReferences(userId: string) {
    // Break profile self-references first.
    await supabaseAdmin.from('profiles').update({ approver_id: null }).eq('approver_id', userId);
    await supabaseAdmin.from('profiles').update({ deactivated_by: null }).eq('deactivated_by', userId);

    // Notification tables can retain FK to profiles and block hard delete.
    await supabaseAdmin.from('notification_logs').delete().eq('recipient_user_id', userId);
    await supabaseAdmin.from('notification_jobs').delete().eq('recipient_user_id', userId);
    await supabaseAdmin.from('notification_jobs').delete().eq('actor_id', userId);

    // Payee request links.
    await supabaseAdmin.from('payee_change_requests').delete().eq('requested_by', userId);
    await supabaseAdmin.from('payee_change_requests').delete().eq('reviewed_by', userId);

    // Claim/payment links.
    const { data: claims } = await supabaseAdmin.from('claims').select('id').eq('applicant_id', userId);
    const claimIds = (claims || []).map((item) => item.id);
    if (claimIds.length > 0) {
        await supabaseAdmin.from('notification_logs').delete().in('claim_id', claimIds);
        await supabaseAdmin.from('notification_jobs').delete().in('claim_id', claimIds);
        await supabaseAdmin.from('claim_history').delete().in('claim_id', claimIds);
        await supabaseAdmin.from('claim_items').delete().in('claim_id', claimIds);
    }

    await supabaseAdmin.from('claim_history').delete().eq('actor_id', userId);
    await supabaseAdmin.from('claims').delete().eq('applicant_id', userId);
    await supabaseAdmin.from('payments').delete().eq('paid_by', userId);
    await supabaseAdmin.from('profiles').delete().eq('id', userId);
}

authAdmin.createUser = ((attributes: Parameters<typeof rawCreateUser>[0]) =>
    withNetworkRetry(() => rawCreateUser(attributes))) as typeof authAdmin.createUser;
authAdmin.deleteUser = ((id: Parameters<typeof rawDeleteUser>[0], shouldSoftDelete?: Parameters<typeof rawDeleteUser>[1]) =>
    withNetworkRetry(async () => {
        const firstTry = await rawDeleteUser(id, shouldSoftDelete);
        if (
            firstTry.error &&
            !shouldSoftDelete &&
            String(firstTry.error.message || '').includes('Database error deleting user')
        ) {
            await cleanupTestUserReferences(String(id));
            return rawDeleteUser(id, shouldSoftDelete);
        }
        return firstTry;
    })) as typeof authAdmin.deleteUser;
authAdmin.listUsers = ((params?: Parameters<typeof rawListUsers>[0]) =>
    withNetworkRetry(() => rawListUsers(params))) as typeof authAdmin.listUsers;

export async function authSignInWithRetry(
    client: SupabaseClient,
    email: string,
    password: string,
    maxAttempts = 8
) {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { data: { session }, error } = await client.auth.signInWithPassword({
            email,
            password,
        });
        if (!error && session) return session;

        lastError = error;
        const isRateLimit =
            error?.status === 429 ||
            /rate limit/i.test(String(error?.message || ''));
        if (!isRateLimit || attempt === maxAttempts) {
            throw error ?? new Error('Sign in failed');
        }

        const backoffMs = Math.min(12000, 600 * Math.pow(2, attempt - 1));
        const jitterMs = Math.floor(Math.random() * 500);
        await sleep(backoffMs + jitterMs);
    }

    throw lastError ?? new Error('Sign in failed');
}

/**
 * 將 Supabase Session 注入到 Playwright Page 中
 * 
 * 流程：
 * 1. 用密碼登入取得 session
 * 2. 寫入 Cookie（SSR 用）
 * 3. 寫入 LocalStorage（CSR 用）
 * 4. 重新載入頁面以套用 session
 * 
 * @param page - Playwright Page 實例
 * @param email - 使用者 email
 * @param password - 使用者密碼
 */
export async function injectSession(page: Page, email: string, password: string) {
    const client = createClient(supabaseUrl, supabaseAnonKey);
    const session = await authSignInWithRetry(client, email, password);

    const storageKey = `sb-${projectRef}-auth-token`;
    const encodedSession = `base64-${stringToBase64URL(JSON.stringify(session))}`;
    const sessionCookies = createChunks(storageKey, encodedSession);

    // 依 @supabase/ssr 的 cookie encoding/chunking 規則寫入 SSR cookie。
    await page.context().addCookies(
        sessionCookies.map(({ name, value }) => ({
            name,
            value,
            url: 'http://localhost:5173',
            httpOnly: false,
            secure: false,
            sameSite: 'Lax' as const,
        }))
    );

    // 讓第一個實際導頁前就具備 CSR session。
    await page.addInitScript(({ key, value }) => {
        localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: session });
}

type FormValue = string | string[];
const TEST_BASE_ORIGIN = 'http://localhost:5173';

async function ensureActionOrigin(page: Page) {
    const currentUrl = page.url();
    if (!/^https?:\/\//i.test(currentUrl)) {
        await page.goto(TEST_BASE_ORIGIN, { waitUntil: 'domcontentloaded' });
    }
}

export async function postFormAction(
    page: Page,
    url: string,
    form: Record<string, FormValue> = {}
) {
    await ensureActionOrigin(page);
    return page.evaluate(
        async ({
            targetUrl,
            payload,
            baseOrigin,
        }: {
            targetUrl: string;
            payload: Record<string, FormValue>;
            baseOrigin: string;
        }) => {
            const fd = new FormData();
            for (const [k, v] of Object.entries(payload)) {
                if (Array.isArray(v)) {
                    for (const val of v) fd.append(k, val);
                } else {
                    fd.append(k, v);
                }
            }
            const locationOrigin =
                typeof window !== "undefined" &&
                window.location?.origin?.startsWith("http")
                    ? window.location.origin
                    : baseOrigin;
            const resolvedUrl = new URL(targetUrl, locationOrigin).toString();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(resolvedUrl, {
                method: 'POST',
                body: fd,
                headers: { 'x-sveltekit-action': 'true' },
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return res.text();
        },
        { targetUrl: url, payload: form, baseOrigin: TEST_BASE_ORIGIN }
    );
}

export async function postFormActionDetailed(
    page: Page,
    url: string,
    form: Record<string, FormValue> = {}
) {
    await ensureActionOrigin(page);
    return page.evaluate(
        async ({
            targetUrl,
            payload,
            baseOrigin,
        }: {
            targetUrl: string;
            payload: Record<string, FormValue>;
            baseOrigin: string;
        }) => {
            const fd = new FormData();
            for (const [k, v] of Object.entries(payload)) {
                if (Array.isArray(v)) {
                    for (const val of v) fd.append(k, val);
                } else {
                    fd.append(k, v);
                }
            }
            const locationOrigin =
                typeof window !== "undefined" &&
                window.location?.origin?.startsWith("http")
                    ? window.location.origin
                    : baseOrigin;
            const resolvedUrl = new URL(targetUrl, locationOrigin).toString();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(resolvedUrl, {
                method: 'POST',
                body: fd,
                headers: { 'x-sveltekit-action': 'true' },
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return { url: res.url, body: await res.text(), status: res.status };
        },
        { targetUrl: url, payload: form, baseOrigin: TEST_BASE_ORIGIN }
    );
}
