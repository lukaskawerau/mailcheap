import { NextResponse } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { withJobSignature } from "@/lib/job-route";
import { runScheduledSend } from "@/lib/scheduling";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Handled outcomes answer 200; a thrown error (database down) is retried by the worker.
// Each outcome is logged: it's the trace of when and why a scheduled issue went out or didn't.
async function handleScheduled(body) {
	if (!isSendingEnabled()) return NextResponse.json({ error: "Sending is off" }, { status: 409 });
	const result = await runScheduledSend({ campaignId: body?.campaignId, scheduledAt: body?.scheduledAt });
	console.info(`[scheduled] ${JSON.stringify({ campaignId: body?.campaignId, scheduledAt: body?.scheduledAt, ...result })}`);
	return NextResponse.json(result);
}

export const POST = withJobSignature("scheduled", handleScheduled);
