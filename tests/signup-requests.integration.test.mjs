import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mongoose from "mongoose";
import { createSignupStore, parseSignupRequest } from "../lib/signup-requests.js";
import { createConfirmToken, verifyConfirmToken } from "../lib/confirmation.js";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "../lib/unsubscribe.js";
import { createJobQueue } from "../lib/jobs/queue.js";
import { reconcileConfirmationJobs } from "../lib/jobs/reconcile.js";

const uri = process.env.MAILCHEAP_TEST_MONGODB_URI;
const day = 86_400_000;
process.env.SESSION_SECRET = "isolated-audit-links-secret-at-least-32-characters";

test("consent admission and confirmation recovery use standalone Mongo", { skip: !uri, timeout: 30_000 }, async (t) => {
	const dbName = `mailcheap_audit_signup_${randomUUID().replaceAll("-", "")}`;
	const client = new mongoose.mongo.MongoClient(uri);
	await client.connect();
	const db = client.db(dbName);
	let now = new Date("2026-10-17T10:00:00.000Z");
	const contacts = db.collection("contacts");
	const suppressions = db.collection("suppressions");
	await contacts.createIndex({ newsletterId: 1, email: 1 }, { unique: true });
	await contacts.createIndex({ status: 1, "confirmation.state": 1, "confirmation.availableAt": 1 });
	const store = createSignupStore(contacts, suppressions, { now: () => now });
	const newsletterId = new mongoose.Types.ObjectId();
	const request = (email, at = now) => ({ newsletterId, email, requestId: randomUUID(), consentedAt: new Date(at) });
	try {
		await t.test("strict input preserves original consent time and rejects future claims", () => {
			const input = { newsletter: "de-08211000-weekly", email: " Reader@example.invalid ", requestId: randomUUID(), consentedAt: now.toISOString() };
			assert.equal(parseSignupRequest(input, now).email, "reader@example.invalid");
			assert.throws(() => parseSignupRequest({ ...input, requestId: "not-a-uuid" }, now));
			assert.throws(() => parseSignupRequest({ ...input, consentedAt: new Date(+now + 60_001).toISOString() }, now));
		});
		await t.test("concurrent duplicate insertions admit once and preserve deterministic intent", async () => {
			const input = request("duplicate@example.invalid");
			const accepted = await Promise.all(Array.from({ length: 8 }, () => store.accept(input)));
			assert.equal(await contacts.countDocuments({ email: input.email }), 1);
			assert.equal(accepted.filter(({ created }) => created).length, 1);
			assert.ok(accepted.every(({ status }) => status === "pending"));
			const first = await contacts.findOne({ email: input.email });
			await store.accept(input);
			assert.deepEqual((await contacts.findOne({ _id: first._id })).confirmation, first.confirmation);
			await assert.rejects(store.accept({ ...input, consentedAt: new Date(+now - 1000) }), { code: "request-conflict" });
		});
		await t.test("withdrawal wins ties, replay, and a delayed never-seen request", async () => {
			const input = request("withdrawal@example.invalid");
			const accepted = await store.accept(input);
			now = new Date(+now + 2000);
			await store.withdraw({ contactId: accepted.id, newsletterId });
			assert.equal((await store.accept(input)).status, "unsubscribed");
			assert.equal((await store.accept(request(input.email, new Date(+now - 1)))).status, "unsubscribed");
			assert.equal((await store.accept(request(input.email, now))).status, "unsubscribed");
			const barrier = (await contacts.findOne({ _id: new mongoose.Types.ObjectId(accepted.id) })).unsubscribedAt;
			now = new Date(+now + 1);
			assert.equal((await store.accept(request(input.email))).status, "pending");
			assert.deepEqual((await contacts.findOne({ email: input.email })).unsubscribedAt, barrier);
		});
		await t.test("a repeated withdrawal fences consent delayed between both withdrawals", async () => {
			const input = request("repeat-withdrawal@example.invalid");
			const accepted = await store.accept(input);
			now = new Date(+now + 1000);
			await store.withdraw({ contactId: accepted.id, newsletterId });
			const delayed = request(input.email, new Date(+now + 1000));
			now = new Date(+now + 2000);
			await store.withdraw({ contactId: accepted.id, newsletterId });
			assert.equal((await store.accept(delayed)).status, "unsubscribed");
			const current = await contacts.findOne({ email: input.email });
			assert.deepEqual(current.unsubscribedAt, now);
			assert.equal(current.confirmation, undefined);
		});
		await t.test("reordered consent and equal timestamps use one monotone order", async () => {
			const newer = { ...request("order@example.invalid"), requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
			await store.accept(newer);
			await store.accept({ ...newer, requestId: "00000000-0000-4000-8000-000000000000" });
			await store.accept({ ...newer, requestId: randomUUID(), consentedAt: new Date(+now - 1) });
			assert.equal((await contacts.findOne({ email: newer.email })).signup.requestId, newer.requestId);
		});
		await t.test("confirmed subscribers stay active and permanent suppressions stay blocked", async () => {
			await contacts.insertOne({ newsletterId, email: "active@example.invalid", status: "active" });
			assert.equal((await store.accept(request("active@example.invalid"))).outcome, "already-active");
			await suppressions.insertOne({ email: "global@example.invalid", reason: "complaint" });
			assert.equal((await store.accept(request("global@example.invalid"))).status, "complained");
			await contacts.insertOne({ newsletterId, email: "local@example.invalid", status: "bounced" });
			assert.equal((await store.accept(request("local@example.invalid"))).status, "bounced");
		});
		await t.test("generation links survive a resend but fail after cancellation and reconsent", async () => {
			const input = request("links@example.invalid");
			const accepted = await store.accept(input);
			const first = await contacts.findOne({ email: input.email });
			const reference = { contactId: accepted.id, newsletterId: String(newsletterId), generation: first.confirmation.generation };
			const token = createConfirmToken(reference, +now);
			now = new Date(+now + 1000);
			await store.accept(request(input.email));
			assert.equal((await contacts.findOne({ email: input.email })).confirmation.generation, reference.generation);
			await store.withdraw(reference);
			now = new Date(+now + 1);
			await store.accept(request(input.email));
			assert.equal((await store.confirm(verifyConfirmToken(token, +now))).confirmed, false);
			const current = await contacts.findOne({ email: input.email });
			assert.notEqual(current.confirmation.generation, reference.generation);
			assert.equal((await store.confirm({ ...reference, generation: current.confirmation.generation })).confirmed, true);
			assert.deepEqual(verifyUnsubscribeToken(createUnsubscribeToken(reference)), { contactId: accepted.id, newsletterId: String(newsletterId) });
			assert.equal(verifyConfirmToken(token, +now + 31 * day), null);
		});
		await t.test("legacy pending links remain valid only before managed signup or withdrawal", async () => {
			const legacy = { _id: new mongoose.Types.ObjectId(), newsletterId, email: "legacy@example.invalid", status: "pending" };
			await contacts.insertOne(legacy);
			const reference = { contactId: String(legacy._id), newsletterId: String(newsletterId) };
			assert.equal((await store.confirm(verifyConfirmToken(createConfirmToken(reference)))).confirmed, true);
			const managed = await store.accept(request("managed@example.invalid"));
			assert.equal((await store.confirm({ contactId: managed.id, newsletterId })).confirmed, false);
			await suppressions.insertOne({ email: legacy.email, reason: "bounce" });
			assert.equal((await store.confirm(reference)).contact, null);
		});
		await t.test("reconciliation repairs admission-before-enqueue and leaves dead work stopped", async () => {
			const accepted = await store.accept(request("recovery@example.invalid"));
			const queue = createJobQueue(db.collection("deliveryjobs"), { now: () => now });
			await queue.ensureIndexes();
			await reconcileConfirmationJobs(contacts, queue, now);
			const job = await db.collection("deliveryjobs").findOne({ key: `confirmation:${accepted.id}:${accepted.requestId}` });
			assert.ok(job);
			await db.collection("deliveryjobs").updateOne({ _id: job._id }, { $set: { status: "dead", failures: 8 } });
			await reconcileConfirmationJobs(contacts, queue, now);
			assert.equal((await db.collection("deliveryjobs").findOne({ _id: job._id })).status, "dead");
		});
	} finally {
		await db.dropDatabase();
		await client.close();
	}
});
