import "server-only";
import { getJobQueue } from "@/lib/jobs";
import { assertJobSecret, readJobBody, verifyJob } from "./jobs/auth.js";

// Authentication is required in development too. A signed request must also match a persisted,
// currently leased job; an old signature cannot replay a completed or reclaimed job.
export function withJobSignature(kind, handler) {
	return async function POST(request) {
		let secret;
		try { secret = assertJobSecret(); }
		catch { return Response.json({ error: "Delivery worker is not configured" }, { status: 503 }); }
		let body;
		try { body = await readJobBody(request); }
		catch { return Response.json({ error: "Invalid job body" }, { status: 413 }); }
		const job = verifyJob(request, kind, body, secret);
		if (!job) return Response.json({ error: "Invalid job signature" }, { status: 401 });
		const queue = await getJobQueue();
		if (!await queue.owns(job, kind, body)) return Response.json({ error: "Job lease is not current" }, { status: 403 });
		let payload;
		try { payload = JSON.parse(body); }
		catch { return Response.json({ error: "Invalid job body" }, { status: 400 }); }
		return handler(payload);
	};
}
