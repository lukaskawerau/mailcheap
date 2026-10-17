import { withJobSignature } from "@/lib/job-route";
import { sendPendingConfirmation } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";

async function handleConfirmation(body) {
	if (!isObjectIdString(body?.contactId) || typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId)) return Response.json({ error: "Invalid confirmation job" }, { status: 400 });
	const result = await sendPendingConfirmation(body);
	if (result.deferUntil) return Response.json({ deferred: true }, { status: 409, headers: { "retry-after": String(Math.max(1, Math.ceil((+result.deferUntil - Date.now()) / 1000))) } });
	return Response.json(result, { status: result.retry ? 503 : 200 });
}

export const POST = withJobSignature("confirmation", handleConfirmation);
