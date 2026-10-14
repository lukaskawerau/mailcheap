// Opt in with MAILCHEAP_TEST_MONGODB_URI. Collections have a random test-only prefix; no existing
// campaigns, messages, contacts or subscribers are read or written by these recovery tests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import mongoose from "mongoose";
import { createJobQueue } from "../lib/jobs/queue.js";
import { dispatchJob } from "../lib/jobs/dispatch.js";
import { reconcileCampaignJobs } from "../lib/jobs/reconcile.js";

const uri = process.env.MAILCHEAP_TEST_MONGODB_URI;
test("Mongo delivery jobs survive restarts, fence stale leases and recover the outbox", { skip: !uri, timeout: 30_000 }, async (t) => {
	const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
	await client.connect();
	const db = client.db();
	const prefix = `mailworker_test_${randomUUID().replaceAll("-", "")}`;
	const jobs = db.collection(`${prefix}_jobs`);
	const campaigns = db.collection(`${prefix}_campaigns`);
	let clock = Date.UTC(2026, 9, 14, 16);
	const options = { now: () => new Date(clock), leaseMs: 1000, random: () => 0.5 };
	let queue = createJobQueue(jobs, options);
	const campaignId = () => new mongoose.Types.ObjectId().toString();
	await queue.ensureIndexes();
	try {
		await t.test("concurrent producers and consumers get one durable owner", async () => {
			const id = campaignId();
			await Promise.all(Array.from({ length: 12 }, () => queue.enqueueCampaign(id)));
			assert.equal(await jobs.countDocuments({}), 1);
			const claims = await Promise.all(Array.from({ length: 12 }, () => queue.claim()));
			assert.equal(claims.filter(Boolean).length, 1);
			const first = claims.find(Boolean);
			assert.equal(await queue.owns(first, "campaign", first.body), true);
			assert.equal(await queue.owns(first, "scheduled", first.body), false);
			assert.equal(await queue.owns(first, "campaign", first.body + " "), false);
			clock += 1001; // A killed worker can no longer renew or acknowledge this attempt.
			assert.equal(await queue.renew(first), false);
			assert.equal((await queue.acknowledge(first, 200)).acknowledged, false);
			queue = createJobQueue(jobs, options); // A fresh process sees the persisted lease.
			const recovered = await queue.claim();
			assert.equal(recovered._id, first._id);
			assert.notEqual(recovered.leaseToken, first.leaseToken);
			clock += 10;
			assert.equal(await queue.renew(recovered), true);
			assert.equal(await queue.owns(first, "campaign", first.body), false);
			assert.equal((await queue.acknowledge(first, 200)).acknowledged, false);
			assert.equal((await queue.acknowledge(recovered, 200)).acknowledged, true);
			assert.equal(await queue.claim(), null);
			assert.ok((await jobs.findOne({ _id: first._id })).expiresAt instanceof Date);
		});

		await t.test("future schedules wait and changed schedules retain distinct identities", async () => {
			const id = campaignId();
			const at = new Date(clock + 90 * 24 * 60 * 60_000);
			const old = await queue.scheduleCampaign(id, at);
			const newer = await queue.scheduleCampaign(id, new Date(at.getTime() + 60_000));
			assert.notEqual(old._id, newer._id);
			assert.equal(await queue.claim(), null);
			clock = at.getTime();
			const due = await queue.claim();
			assert.equal(due._id, old._id);
			await queue.acknowledge(due, 200);
			clock += 60_000;
			await queue.acknowledge(await queue.claim(), 200);
		});

		await t.test("sending off preserves jobs; failures back off, stop, and require explicit retry", async () => {
			const entry = await queue.enqueueCampaign(campaignId());
			let job = await queue.claim();
			await queue.acknowledge(job, 409);
			assert.equal((await jobs.findOne({ _id: entry._id })).failures, 0);
			assert.equal(await queue.claim(), null);
			clock += 60_000;
			for (let attempt = 1; attempt <= 8; attempt++) {
				job = await queue.claim();
				assert.ok(job);
				await queue.acknowledge(job, 503);
				const stored = await jobs.findOne({ _id: job._id });
				assert.equal(stored.failures, attempt);
				assert.equal(stored.expiresAt, undefined);
				if (attempt < 8) { assert.equal(await queue.claim(), null); clock = stored.availableAt.getTime(); }
			}
			assert.equal(await queue.claim(), null);
			assert.equal((await queue.enqueueCampaign(JSON.parse(job.body).campaignId)).status, "dead");
			assert.equal(await queue.retryFailed(job._id), true);
			assert.equal(await queue.retryFailed(job._id), false);
			job = await queue.claim();
			await queue.acknowledge(job, 202);
			const nextBatch = await queue.claim();
			assert.equal(nextBatch.failures, 0);
			await queue.acknowledge(nextBatch, 200);
		});

		await t.test("a missing enqueue after a campaign state write is repaired, while paused and draft stay idle", async () => {
			const sending = new mongoose.Types.ObjectId();
			const scheduled = new mongoose.Types.ObjectId();
			await campaigns.insertMany([
				{ _id: sending, status: "sending" },
				{ _id: scheduled, status: "scheduled", scheduledAt: new Date(clock + 60_000) },
				{ _id: new mongoose.Types.ObjectId(), status: "paused" },
				{ _id: new mongoose.Types.ObjectId(), status: "draft" },
			]);
			await reconcileCampaignJobs(campaigns, queue);
			await reconcileCampaignJobs(campaigns, queue);
			assert.equal(await jobs.countDocuments({ status: "queued" }), 2);
			let job = await queue.claim();
			assert.equal(JSON.parse(job.body).campaignId, String(sending));
			await queue.acknowledge(job, 401);
			await reconcileCampaignJobs(campaigns, queue);
			assert.equal((await jobs.findOne({ _id: job._id })).status, "dead");
			await campaigns.updateOne({ _id: sending }, { $set: { status: "paused" } });
			assert.equal(await queue.retryFailed(job._id), true);
			await queue.acknowledge(await queue.claim(), 200);
			clock += 60_000;
			await queue.acknowledge(await queue.claim(), 200);
			await campaigns.updateOne({ _id: scheduled }, { $set: { status: "draft" } });
		});

		await t.test("dispatch renews long requests and aborts after ownership is lost", async () => {
			await queue.enqueueCampaign(campaignId());
			let job = await queue.claim();
			clock += 10;
			let beats = 0;
			const secret = "a".repeat(64);
			let result = await dispatchJob(job, queue, {
				appUrl: "http://mailcheap:3000", secret, renewMs: 5,
				heartbeat: async () => { beats++; clock += 10; },
				fetchImpl: async (_url, { signal }) => { await delay(80, null, { signal }); return new Response(null, { status: 200 }); },
			});
			assert.ok(beats > 1);
			assert.equal(result.acknowledged, true);
			await queue.enqueueCampaign(campaignId());
			job = await queue.claim();
			let replacement;
			result = await dispatchJob(job, queue, {
				appUrl: "http://mailcheap:3000", secret, renewMs: 20,
				fetchImpl: async (_url, { signal }) => {
					clock += 1001;
					replacement = await queue.claim();
					await delay(1000, null, { signal });
					throw new Error("Expected the lost lease to abort this request");
				},
			});
			assert.equal(result.httpStatus, 0);
			assert.equal(result.acknowledged, false);
			assert.notEqual(replacement.leaseToken, job.leaseToken);
			await queue.acknowledge(replacement, 200);
		});

		await t.test("a lost response retries and successful partial batches continue without using the failure budget", async () => {
			await queue.enqueueCampaign(campaignId());
			let job = await queue.claim();
			const secret = "a".repeat(64);
			const seen = [];
			let result = await dispatchJob(job, queue, { appUrl: "http://mailcheap:3000", secret, fetchImpl: async (url, request) => {
				seen.push({ url: String(url), request });
				throw new Error("Lost after the server processed it");
			} });
			assert.equal(result.status, "queued");
			assert.equal(seen[0].url, "http://mailcheap:3000/api/jobs/send-batch");
			assert.equal(seen[0].request.redirect, "error");
			assert.equal(seen[0].request.body, job.body);
			clock = (await jobs.findOne({ _id: job._id })).availableAt.getTime();
			job = await queue.claim();
			result = await dispatchJob(job, queue, { appUrl: "http://mailcheap:3000", secret, fetchImpl: async () => new Response(null, { status: 202 }) });
			assert.equal(result.status, "queued");
			job = await queue.claim();
			assert.equal(job.failures, 0);
			await dispatchJob(job, queue, { appUrl: "http://mailcheap:3000", secret, fetchImpl: async () => new Response(null, { status: 200 }) });
			assert.equal(await queue.claim(), null);
		});
	} finally {
		// Only this test's named collections can be removed, including on a failed assertion.
		await Promise.all([jobs.drop().catch((e) => { if (e.code !== 26) throw e; }), campaigns.drop().catch((e) => { if (e.code !== 26) throw e; })]);
		await client.close();
	}
});
