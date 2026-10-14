import { NextResponse } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { withJobSignature } from "@/lib/job-route";
import { sendQueuedCampaignBatch } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handleBatch(body) {
	if (!isSendingEnabled()) return NextResponse.json({ error: "Sending is off" }, { status: 409 });

	if (!isObjectIdString(body?.campaignId)) {
		return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
	}

	const result = await sendQueuedCampaignBatch(body.campaignId);
	return NextResponse.json(result, { status: result.retry ? 503 : result.pending ? 202 : 200 });
}

export const POST = withJobSignature("campaign", handleBatch);
