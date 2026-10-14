import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { JOB_PATHS } from "./queue.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BODY_BYTES = 16_384;

export function assertJobSecret(secret = process.env.JOB_WORKER_SECRET) {
	if (typeof secret !== "string" || secret.length < 32) throw new Error("JOB_WORKER_SECRET must contain at least 32 random characters");
	return secret;
}

function signature(secret, path, body, id, token, timestamp) {
	const digest = createHash("sha256").update(body).digest("hex");
	return createHmac("sha256", secret).update(["POST", path, id, token, timestamp, digest].join("\n")).digest("hex");
}

export function signJob(job, secret, now = Date.now()) {
	assertJobSecret(secret);
	const timestamp = String(Math.floor(now / 1000));
	return {
		"content-type": "application/json",
		"x-mailcheap-job": job._id,
		"x-mailcheap-lease": job.leaseToken,
		"x-mailcheap-timestamp": timestamp,
		"x-mailcheap-signature": signature(secret, JOB_PATHS[job.kind], job.body, job._id, job.leaseToken, timestamp),
	};
}

export function verifyJob(request, kind, body, secret, now = Date.now()) {
	assertJobSecret(secret);
	const id = request.headers.get("x-mailcheap-job") ?? "";
	const token = request.headers.get("x-mailcheap-lease") ?? "";
	const timestamp = request.headers.get("x-mailcheap-timestamp") ?? "";
	const supplied = request.headers.get("x-mailcheap-signature") ?? "";
	const path = new URL(request.url).pathname;
	if (request.method !== "POST" || path !== JOB_PATHS[kind] || !UUID.test(id) || !UUID.test(token) ||
		!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 60_000 || !/^[a-f0-9]{64}$/.test(supplied)) return null;
	const expected = signature(secret, path, body, id, token, timestamp);
	if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) return null;
	return { _id: id, leaseToken: token };
}

export async function readJobBody(request) {
	if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new Error("Job body is too large");
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Job body is too large"); }
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally { reader.releaseLock(); }
}
