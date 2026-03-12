import { createClient } from "@supabase/supabase-js";
import { env } from "$env/dynamic/private";
import { PUBLIC_SUPABASE_URL } from "$env/static/public";

export type PayeeNotificationEventCode =
    | "payee_create_submitted"
    | "payee_update_submitted"
    | "payee_disable_submitted"
    | "payee_request_withdrawn"
    | "payee_request_approved"
    | "payee_request_rejected";

type EnqueuePayeeNotificationInput = {
    eventCode: PayeeNotificationEventCode;
    requestId: string;
    actorId: string;
    reason?: string | null;
};

type Recipient = {
    userId: string;
    email: string;
    ccEmails: string[];
};

function getServiceRoleClient() {
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!PUBLIC_SUPABASE_URL || !key) {
        throw new Error("Missing SUPABASE service role env for payee notifications");
    }
    return createClient(PUBLIC_SUPABASE_URL, key);
}

function normalizeEmail(value: unknown): string {
    return String(value || "").trim().toLowerCase();
}

function toChangeTypeLabel(changeType: string): string {
    if (changeType === "create") return "新增";
    if (changeType === "update") return "變更";
    if (changeType === "disable") return "停用";
    return changeType || "-";
}

function resolveRecipients(params: {
    eventCode: PayeeNotificationEventCode;
    requester?: { id?: string; email?: string | null };
    financeRecipients: Array<{ id?: string; email?: string | null }>;
    actorEmail?: string | null;
}): Recipient[] {
    const requesterEmail = normalizeEmail(params.requester?.email);
    const actorEmail = normalizeEmail(params.actorEmail);

    if (params.eventCode === "payee_request_approved" || params.eventCode === "payee_request_rejected") {
        if (!requesterEmail || !params.requester?.id) return [];
        const cc = actorEmail && actorEmail !== requesterEmail ? [actorEmail] : [];
        return [
            {
                userId: params.requester.id,
                email: requesterEmail,
                ccEmails: cc
            }
        ];
    }

    // submitted / withdrawn -> notify finance queue
    const mapped = (params.financeRecipients || [])
        .map((r) => {
            const email = normalizeEmail(r.email);
            if (!r.id || !email) return null;
            const cc = requesterEmail && requesterEmail !== email ? [requesterEmail] : [];
            return {
                userId: r.id,
                email,
                ccEmails: cc
            };
        })
        .filter((v): v is Recipient => Boolean(v));

    return mapped;
}

export async function enqueuePayeeRequestNotifications({
    eventCode,
    requestId,
    actorId,
    reason
}: EnqueuePayeeNotificationInput): Promise<number> {
    const supabase = getServiceRoleClient();

    const { data: mapping, error: mappingError } = await supabase
        .from("notification_event_template_map")
        .select("template_key, is_active")
        .eq("event_code", eventCode)
        .eq("channel", "email")
        .maybeSingle();
    if (mappingError) {
        console.error("[notify:payee] mapping query error", mappingError);
    }
    if (!mapping || !mapping.is_active || !mapping.template_key) {
        console.warn("[notify:payee] no active mapping for", eventCode, "mapping:", mapping);
        return 0;
    }

    const { data: request, error: requestError } = await supabase
        .from("payee_change_requests")
        .select(`
            id,
            payee_id,
            change_type,
            status,
            reason,
            proposed_data,
            requested_by,
            reviewed_by
        `)
        .eq("id", requestId)
        .maybeSingle();
    if (requestError) {
        console.error("[notify:payee] request query error", requestError);
    }
    if (!request) {
        console.warn("[notify:payee] request not found for id:", requestId);
        return 0;
    }

    // Fetch payee name separately (no FK between payee_change_requests and payees)
    let payeeNameFromDb: string | null = null;
    if (request.payee_id) {
        const { data: payeeRow } = await supabase
            .from("payees")
            .select("name")
            .eq("id", request.payee_id)
            .maybeSingle();
        payeeNameFromDb = payeeRow?.name || null;
    }

    const [actorProfileResponse, financeUsersResponse, requesterProfileResponse] = await Promise.all([
        supabase
            .from("profiles")
            .select("id, full_name, email")
            .eq("id", actorId)
            .maybeSingle(),
        supabase
            .from("profiles")
            .select("id, email")
            .eq("is_finance", true)
            .eq("is_active", true),
        request.requested_by
            ? supabase
                .from("profiles")
                .select("id, full_name, email")
                .eq("id", request.requested_by)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null } as const)
    ]);

    if (actorProfileResponse.error) {
        console.error("[notify:payee] actor profile query error", actorProfileResponse.error);
    }
    if (financeUsersResponse.error) {
        console.error("[notify:payee] finance users query error", financeUsersResponse.error);
    }
    if (requesterProfileResponse.error) {
        console.error("[notify:payee] requester profile query error", requesterProfileResponse.error);
    }

    const actorProfile = actorProfileResponse.data;
    const financeUsers = financeUsersResponse.data || [];
    const requesterProfile = requesterProfileResponse.data;

    const recipients = resolveRecipients({
        eventCode,
        requester: requesterProfile || undefined,
        financeRecipients: financeUsers || [],
        actorEmail: actorProfile?.email || null
    });
    if (recipients.length === 0) return 0;

    const payeeName = String(
        request?.proposed_data?.name ||
        payeeNameFromDb ||
        "收款人"
    ).trim();
    const finalReason = String(reason || request.reason || "").trim();
    const actorName = String(actorProfile?.full_name || "系統").trim();
    const nowIso = new Date().toISOString();

    const rows = recipients.map((recipient) => ({
        event_code: eventCode,
        channel: "email",
        template_key: mapping.template_key,
        claim_id: null,
        actor_id: actorId,
        recipient_user_id: recipient.userId,
        recipient_email: recipient.email,
        cc_emails: recipient.ccEmails,
        payload: {
            object_type: "payee_request",
            event_code: eventCode,
            payee_request_id: request.id,
            payee_id: request.payee_id,
            payee_name: payeeName,
            change_type: request.change_type,
            change_type_label: toChangeTypeLabel(request.change_type),
            request_status: request.status,
            actor_name: actorName,
            reason: finalReason,
            request_link_path: "/payees"
        },
        status: "queued",
        attempts: 0,
        max_attempts: 3,
        dedupe_key: `payee-event:${request.id}:${recipient.userId}:${eventCode}:email`,
        scheduled_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso
    }));

    const { error } = await supabase
        .from("notification_jobs")
        .upsert(rows, { onConflict: "channel,dedupe_key", ignoreDuplicates: true });

    if (error) {
        console.error("[notify:payee] enqueue failed", error);
        return 0;
    }
    return rows.length;
}
