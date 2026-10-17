import { signJob } from "./auth.js";
import { JOB_PATHS } from "./queue.js";

// The worker contains no SES credentials or mail content. It can call only the fixed job routes;
// redirects are forbidden so the shared secret cannot follow a redirect to another service.
export async function dispatchJob(job, queue, { appUrl, secret, fetchImpl = fetch, heartbeat = async () => {}, timeoutMs = 240_000, renewMs = 30_000 }) {
	const controller = new AbortController();
	let renewing = false;
	const timer = setInterval(async () => {
		if (renewing) return;
		renewing = true;
		try {
			if (!await queue.renew(job)) controller.abort();
			else await heartbeat();
		} catch { controller.abort(); }
		finally { renewing = false; }
	}, renewMs);
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	let status = 0;
	let deferUntil;
	try {
		const response = await fetchImpl(new URL(JOB_PATHS[job.kind], appUrl), {
			method: "POST", headers: signJob(job, secret), body: job.body, redirect: "error", signal: controller.signal,
		});
		status = response.status;
		const retry = response.headers.get("retry-after");
		if (status === 409 && retry && /^\d+$/.test(retry)) deferUntil = new Date(Date.now() + Math.min(86_400, Number(retry)) * 1000);
		await response.body?.cancel(); // Outcomes are status codes; never log recipient data from responses.
	} catch { /* A lost response is retried. Message claims prevent resending already claimed recipients. */ }
	finally { clearInterval(timer); clearTimeout(timeout); }
	return { httpStatus: status, ...await queue.acknowledge(job, status, deferUntil) };
}
