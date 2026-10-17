import { NextResponse } from "next/server";
import { withdrawContact } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import Campaign from "@/models/Campaign";
import Message from "@/models/Message";

const NO_STORE = { "Cache-Control": "no-store" };
const RECENT_CAMPAIGNS = 5;
// Gmail and Yahoo send one-click requests from shared mail servers, so keep this generous.
const RATE_LIMIT = { name: "unsubscribe", limit: 60, window: "1 m" };

// Links don't carry the campaign, so the unsubscribe counts for the latest campaign sent to them.
async function creditLatestCampaign({ contactId, newsletterId }) {
	const campaigns = await Campaign.find({ newsletterId, startedAt: { $ne: null } })
		.sort({ startedAt: -1 })
		.limit(RECENT_CAMPAIGNS)
		.select({ _id: 1 })
		.lean();
	for (const { _id } of campaigns) {
		const wasSent = await Message.exists({
			kind: "campaign",
			campaignId: _id,
			contactId,
			sentAt: { $ne: null },
		});
		if (!wasSent) continue;
		await Campaign.updateOne({ _id }, { $inc: { "stats.unsubscribed": 1 } });
		return;
	}
}

async function unsubscribe({ contactId, newsletterId }) {
	await connectDb();
	const previous = await withdrawContact({ contactId, newsletterId });
	if (!previous || previous.status === "unsubscribed") return;

	console.log(`[unsubscribe] Contact ${contactId} unsubscribed from newsletter ${newsletterId}`);
	await creditLatestCampaign({ contactId, newsletterId }).catch((error) =>
		console.error("[unsubscribe] Could not credit the campaign:", error.message)
	);
}

function redirectToPage(request, params) {
	const url = new URL("/unsubscribe", request.url);
	for (const [key, value] of Object.entries(params)) {
		if (value) url.searchParams.set(key, value);
	}
	const response = NextResponse.redirect(url, 303);
	response.headers.set("Cache-Control", "no-store");
	return response;
}

// Some mail apps open the List-Unsubscribe URL in a browser: never change anything on GET.
export function GET(request) {
	return redirectToPage(request, { token: new URL(request.url).searchParams.get("token") });
}

// RFC 8058 one-click endpoint. The confirmation page form posts here too, with source=page.
export async function POST(request) {
	const token = new URL(request.url).searchParams.get("token");
	const form = await request.formData().catch(() => null);
	const isPageForm = form?.get("source") === "page";

	function respond(status, pageStatus) {
		if (!isPageForm) return new NextResponse(null, { status, headers: NO_STORE });
		return redirectToPage(request, {
			token: pageStatus === "invalid" ? null : token,
			status: pageStatus,
		});
	}

	if (await isRateLimited({ ...RATE_LIMIT, key: getClientIp(request.headers) })) return respond(429, "error");

	const reference = verifyUnsubscribeToken(token);
	if (!reference) return respond(400, "invalid");

	try {
		await unsubscribe(reference);
		return respond(200, "done");
	} catch (error) {
		console.error("[unsubscribe] Failed:", error);
		return respond(500, "error");
	}
}
