import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertJobSecret, readJobBody, signJob, verifyJob } from "../lib/jobs/auth.js";
import { jobOutcome, JOB_PATHS } from "../lib/jobs/queue.js";

const secret = "a".repeat(64);
const now = Date.UTC(2026, 9, 14, 16);
const job = { _id: randomUUID(), leaseToken: randomUUID(), kind: "campaign", body: JSON.stringify({ campaignId: "123456789012345678901234" }) };
const request = (headers = signJob(job, secret, now), path = JOB_PATHS.campaign, method = "POST") => new Request(`http://mailcheap:3000${path}`, { method, headers });

test("job authentication binds body, path, method, timestamp, job id and lease", () => {
	assert.deepEqual(verifyJob(request(), "campaign", job.body, secret, now), { _id: job._id, leaseToken: job.leaseToken });
	assert.equal(verifyJob(request(), "campaign", job.body + " ", secret, now), null);
	assert.equal(verifyJob(request(), "scheduled", job.body, secret, now), null);
	assert.equal(verifyJob(request(undefined, JOB_PATHS.scheduled), "scheduled", job.body, secret, now), null);
	assert.equal(verifyJob(request(undefined, JOB_PATHS.campaign, "GET"), "campaign", job.body, secret, now), null);
	assert.equal(verifyJob(request(), "campaign", job.body, secret, now + 61_000), null);
	assert.equal(verifyJob(request(), "campaign", job.body, secret, now - 61_000), null);
	assert.equal(verifyJob(request(), "campaign", job.body, "b".repeat(64), now), null);
	for (const field of ["x-mailcheap-job", "x-mailcheap-lease", "x-mailcheap-timestamp", "x-mailcheap-signature"]) {
		const headers = new Headers(signJob(job, secret, now));
		headers.set(field, field.includes("signature") ? "0".repeat(64) : field.includes("timestamp") ? String(now / 1000 + 1) : randomUUID());
		assert.equal(verifyJob(request(headers), "campaign", job.body, secret, now), null);
	}
	assert.equal(verifyJob(request({}), "campaign", job.body, secret, now), null);
	assert.throws(() => assertJobSecret("short"), /JOB_WORKER_SECRET/);
});

test("job bodies are bounded even without a content-length header", async () => {
	assert.equal(await readJobBody(new Request("http://localhost", { method: "POST", body: job.body })), job.body);
	await assert.rejects(readJobBody(new Request("http://localhost", { method: "POST", body: "x".repeat(16_385) })), /too large/);
	await assert.rejects(readJobBody(new Request("http://localhost", { method: "POST", headers: { "content-length": "20000" }, body: "x" })), /too large/);
});

test("retry budget distinguishes a continued batch, the sending switch, transient and permanent errors", () => {
	assert.deepEqual(jobOutcome(202, 7), { status: "queued", delay: 0, failures: 0 });
	assert.deepEqual(jobOutcome(409, 7), { status: "queued", delay: 60_000, failures: 7 });
	assert.equal(jobOutcome(200, 7).status, "completed");
	assert.equal(jobOutcome(401, 0).status, "dead");
	assert.equal(jobOutcome(400, 0).status, "dead");
	for (const code of [0, 408, 425, 429, 500, 503]) {
		assert.deepEqual(jobOutcome(code, 0, () => 0.5), { status: "queued", delay: 5000, failures: 1 });
		assert.equal(jobOutcome(code, 7).status, "dead");
	}
	assert.ok(jobOutcome(503, 4, () => 0).delay < jobOutcome(503, 4, () => 1).delay);
});
