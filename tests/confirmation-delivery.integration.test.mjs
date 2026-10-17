import "./fixtures/mail-runtime.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import mongoose from "mongoose";
import { createSignupStore } from "../lib/signup-requests.js";
import { processConfirmation } from "../lib/confirmation-delivery.js";
import { createJobQueue } from "../lib/jobs/queue.js";
import { dispatchJob } from "../lib/jobs/dispatch.js";
import { campaignEvidence } from "../lib/message-stats.js";
import { setSender } from "./fixtures/fake-ses.mjs";

const uri = process.env.MAILCHEAP_TEST_MONGODB_URI;

test("confirmation delivery recovers known writes and preserves uncertain claims", { skip: !uri, timeout: 30_000 }, async (t) => {
	const client = new mongoose.mongo.MongoClient(uri);
	await client.connect();
	const db = client.db(`mailcheap_audit_delivery_${randomUUID().replaceAll("-", "")}`);
	const contacts = db.collection("contacts");
	const messages = db.collection("messages");
	await contacts.createIndex({ newsletterId: 1, email: 1 }, { unique: true });
	await messages.createIndex({ contactId: 1, confirmationRequestId: 1 }, { unique: true, partialFilterExpression: { kind: "confirmation", confirmationRequestId: { $type: "string" } } });
	let now = new Date("2026-10-17T12:00:00Z");
	const store = createSignupStore(contacts, db.collection("suppressions"), { now: () => now });
	const newsletterId = new mongoose.Types.ObjectId();
	let sends = 0;
	const admit = async () => {
		const accepted = await store.accept({ newsletterId, email: `${randomUUID()}@example.invalid`, requestId: randomUUID(), consentedAt: now });
		return { contactId: new mongoose.Types.ObjectId(accepted.id), requestId: accepted.requestId };
	};
	const options = { contacts, messages, sending: () => true, now: () => now, sendBatch: async ([id]) => {
		sends++;
		await messages.updateOne({ _id: new mongoose.Types.ObjectId(id), status: "queued" }, { $set: { status: "sent", attemptedAt: now, sentAt: now, sesMessageId: `fixture-${sends}` } });
	} };
	try {
		await t.test("message insertion before a crash is reused exactly once", async () => {
			const reference = await admit();
			await assert.rejects(processConfirmation(reference, { ...options, sendBatch: async () => { throw new Error("crash after insertion"); } }));
			const inserted = await messages.findOne({ contactId: reference.contactId });
			assert.equal(inserted.status, "queued");
			const before = sends;
			assert.equal((await processConfirmation(reference, options)).sent, true);
			assert.equal((await processConfirmation(reference, options)).skipped, "confirmation no longer needed");
			assert.equal(sends, before + 1);
			assert.equal(await messages.countDocuments({ contactId: reference.contactId }), 1);
			assert.deepEqual((await messages.findOne({ contactId: reference.contactId }))._id, inserted._id);
		});
		await t.test("a crash after claim or ambiguous SES acceptance never resends", async () => {
			for (const accepted of [false, true]) {
				const reference = await admit();
				await assert.rejects(processConfirmation(reference, { ...options, sendBatch: async ([id]) => {
					await messages.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status: "sent", attemptedAt: now } });
					if (accepted) sends++;
					throw new Error("crash before acceptance evidence");
				} }));
				const before = sends;
				assert.equal((await processConfirmation(reference, options)).uncertain, true);
				assert.equal(sends, before);
			}
		});
		await t.test("positive evidence settles after a lost response without a new send", async () => {
			const reference = await admit();
			await assert.rejects(processConfirmation(reference, { ...options, sendBatch: async (ids) => { await options.sendBatch(ids); throw new Error("crash before settlement"); } }));
			const before = sends;
			assert.equal((await processConfirmation(reference, options)).sent, true);
			assert.equal(sends, before);
		});
		await t.test("a failed matching settlement is retried without transport replay", async () => {
			const reference = await admit();
			const failingContacts = { findOne: contacts.findOne.bind(contacts), updateOne: async () => { throw new Error("settlement unavailable"); } };
			await assert.rejects(processConfirmation(reference, { ...options, contacts: failingContacts }), /settlement unavailable/);
			const before = sends;
			assert.equal((await processConfirmation(reference, options)).sent, true);
			assert.equal(sends, before);
		});
		await t.test("disabled sending persists deferral without creating a message", async () => {
			const reference = await admit();
			const outcome = await processConfirmation(reference, { ...options, sending: () => false });
			assert.ok(+outcome.deferUntil > +now);
			assert.equal(await messages.countDocuments({ contactId: reference.contactId }), 0);
			now = outcome.deferUntil;
			assert.equal((await processConfirmation(reference, options)).sent, true);
		});
		await t.test("rolling cooldown and daily cap recover when time advances", async () => {
			const reference = await admit();
			await messages.insertMany([1, 2, 3].map((n) => ({ _id: new mongoose.Types.ObjectId(), contactId: reference.contactId, newsletterId, kind: "confirmation", status: "sent", attemptedAt: new Date(+now - n * 60_000), sentAt: new Date(+now - n * 60_000) })));
			const outcome = await processConfirmation(reference, options);
			assert.ok(+outcome.deferUntil >= +now + 23 * 60 * 60_000);
			now = new Date(+outcome.deferUntil + 1);
			assert.equal((await processConfirmation(reference, options)).sent, true);
		});
		await t.test("explicit defer time retains the job failure budget", async () => {
			const queue = createJobQueue(db.collection("deliveryjobs"), { now: () => now });
			await queue.ensureIndexes();
			await queue.enqueueConfirmation(new mongoose.Types.ObjectId(), randomUUID());
			const job = await queue.claim();
			await db.collection("deliveryjobs").updateOne({ _id: job._id }, { $set: { failures: 7 } });
			const result = await dispatchJob({ ...job, failures: 7 }, queue, { appUrl: "http://localhost", secret: "x".repeat(32), fetchImpl: async () => new Response(null, { status: 409, headers: { "retry-after": "3600" } }) });
			assert.equal(result.status, "queued");
			const stored = await db.collection("deliveryjobs").findOne({ _id: job._id });
			assert.equal(stored.failures, 7);
			assert.ok(+stored.availableAt > +now);
		});
	} finally { await db.dropDatabase(); await client.close(); }
});

test("real delivery rechecks recipients and webhook safety derives from evidence", { skip: !uri, timeout: 30_000 }, async (t) => {
	const dbName = `mailcheap_audit_runtime_${randomUUID().replaceAll("-", "")}`;
	const mongoUrl = new URL(uri);
	mongoUrl.pathname = `/${dbName}`;
	process.env.MONGODB_URI = mongoUrl.href;
	process.env.SENDING_ENABLED = "true";
	process.env.SEND_RATE_PER_SECOND = "14";
	process.env.SESSION_SECRET = "isolated-transport-secret-with-at-least-32-characters";
	process.env.APP_URL = "https://mail.example.invalid";
	process.env.JOB_WORKER_SECRET = "isolated-worker-secret-with-at-least-32-characters";
	const [{ sendMessageBatch, sendPendingConfirmation, sendQueuedCampaignBatch }, { handleSesEvent }, { default: Contact }, { default: Newsletter }, { default: Campaign }, { default: Message }, { default: Suppression }] = await Promise.all([
		import("../lib/sending.js"), import("../lib/ses-events.js"), import("../models/Contact.js"), import("../models/Newsletter.js"), import("../models/Campaign.js"), import("../models/Message.js"), import("../models/Suppression.js"),
	]);
	await mongoose.connect(process.env.MONGODB_URI);
	await Promise.all([Contact.init(), Newsletter.init(), Campaign.init(), Message.init(), Suppression.init()]);
	const newsletter = await Newsletter.create({ name: "Audit", slug: "audit", fromEmail: "audit@example.invalid", requireConfirmation: false });
	const store = createSignupStore(Contact.collection, Suppression.collection);
	const { upsertContact } = await import("../lib/contacts.js");
	try {
		await t.test("the enforced path sends a managed confirmation despite disabled newsletter confirmation", async () => {
			const accepted = await store.accept({ newsletterId: newsletter._id, email: "managed-send@example.invalid", requestId: randomUUID(), consentedAt: new Date() });
			let sends = 0;
			setSender(async (email) => { sends++; assert.ok(email.html.includes("/confirm?token=")); return { sesMessageId: "managed-evidence" }; });
			assert.equal((await sendPendingConfirmation({ contactId: accepted.id, requestId: accepted.requestId })).sent, true);
			assert.equal(sends, 1);
			assert.equal((await Contact.findById(accepted.id)).status, "pending");
		});
		await t.test("legacy explicit reconsent enters a usable managed confirmation cycle", async () => {
			const contact = await Contact.create({ newsletterId: newsletter._id, email: "legacy-reconsent@example.invalid", status: "unsubscribed", unsubscribedAt: new Date(Date.now() - 60_000) });
			const result = await upsertContact({ newsletter: { ...newsletter.toObject(), requireConfirmation: true }, email: contact.email, resubscribe: true, source: "fixture" });
			assert.equal(result.contact.status, "pending");
			assert.equal(result.contact.signupManaged, true);
			assert.ok(result.contact.unsubscribedAt);
			assert.equal((await store.confirm({ contactId: contact._id, newsletterId: newsletter._id, generation: result.contact.confirmation.generation })).confirmed, true);
		});
		await t.test("an imported repeat opt-out fences consent that has not reached the provider", async () => {
			const { importContactRows } = await import("../lib/contact-import.js");
			const email = "repeat-import-withdrawal@example.invalid";
			await Contact.create({ newsletterId: newsletter._id, email, status: "unsubscribed", unsubscribedAt: new Date(Date.now() - 60_000) });
			const delayed = { newsletterId: newsletter._id, email, requestId: randomUUID(), consentedAt: new Date(Date.now() - 30_000) };
			const importedAt = new Date();
			await importContactRows({ newsletterId: newsletter._id, rows: [{ email, status: "unsubscribed" }] });
			assert.equal((await store.accept(delayed)).status, "unsubscribed");
			assert.ok(+(await Contact.findOne({ email })).unsubscribedAt >= +importedAt);
		});
		await t.test("ambiguous transport stops a managed claim while definite throttling retries the same row", async () => {
			for (const failure of ["TimeoutError", "TooManyRequestsException"]) {
				const accepted = await store.accept({ newsletterId: newsletter._id, email: `${randomUUID()}@example.invalid`, requestId: randomUUID(), consentedAt: new Date() });
				let sends = 0;
				setSender(async () => { sends++; throw Object.assign(new Error("fixture transport failure"), { name: failure }); });
				const first = await sendPendingConfirmation({ contactId: accepted.id, requestId: accepted.requestId });
				const message = await Message.findOne({ contactId: accepted.id });
				if (failure === "TimeoutError") {
					assert.equal(first.uncertain, true);
					assert.equal(message.status, "sent");
					await sendPendingConfirmation({ contactId: accepted.id, requestId: accepted.requestId });
					assert.equal(sends, 1);
				} else {
					assert.equal(first.retry, true);
					assert.equal(message.status, "queued");
					assert.equal(message.attemptedAt, undefined);
					setSender(async () => ({ sesMessageId: "throttle-recovered" }));
					assert.equal((await sendPendingConfirmation({ contactId: accepted.id, requestId: accepted.requestId })).sent, true);
					assert.equal(await Message.countDocuments({ contactId: accepted.id }), 1);
				}
			}
		});
		await t.test("withdrawal or complaint during an earlier send blocks later recipients", async () => {
			for (const action of ["withdraw", "complaint"]) {
				const campaign = await Campaign.create({ newsletterId: newsletter._id, status: "sending", subject: "Audit", format: "markdown", markdown: "Audit text" });
				const first = await Contact.create({ newsletterId: newsletter._id, email: `${randomUUID()}@example.invalid`, status: "active" });
				const second = await Contact.create({ newsletterId: newsletter._id, email: `${randomUUID()}@example.invalid`, status: "active" });
				const messages = await Message.create([first, second].map((contact) => ({ kind: "campaign", campaignId: campaign._id, newsletterId: newsletter._id, contactId: contact._id, email: contact.email })));
				let sends = 0;
				setSender(async () => { sends++; if (action === "withdraw") await store.withdraw({ contactId: second._id, newsletterId: newsletter._id }); else await Suppression.create({ email: second.email, reason: "complaint" }); return { sesMessageId: randomUUID() }; });
				const result = await sendMessageBatch(messages.map(({ _id }) => String(_id)));
				assert.equal(sends, 1);
				assert.equal(result.suppressed, 1);
				assert.equal((await Message.findById(messages[1]._id)).status, "suppressed");
			}
		});
		await t.test("campaign and contact event counters recover under their existing field names", async () => {
			const campaign = await Campaign.create({ newsletterId: newsletter._id, status: "sent", subject: "Counters", format: "markdown", markdown: "Text" });
			const contact = await Contact.create({ newsletterId: newsletter._id, email: "engagement@example.invalid", status: "active" });
			const message = await Message.create({ kind: "campaign", campaignId: campaign._id, newsletterId: newsletter._id, contactId: contact._id, email: contact.email, status: "sent", sentAt: new Date() });
			for (const eventType of ["Open", "Click", "Click"]) await handleSesEvent({ eventType, mail: { messageId: "engagement-evidence", destination: [contact.email], tags: { message_id: [String(message._id)] } }, [eventType.toLowerCase()]: { timestamp: new Date().toISOString(), link: "https://example.invalid/notice" } });
			const updatedCampaign = await Campaign.findById(campaign._id);
			const updatedContact = await Contact.findById(contact._id);
			assert.equal(updatedCampaign.stats.opened, 1);
			assert.equal(updatedCampaign.stats.clicked, 1);
			assert.equal(updatedContact.stats.opens, 1);
			assert.equal(updatedContact.stats.clicks, 1);
			await handleSesEvent({ eventType: "RenderingFailure", mail: { messageId: "engagement-evidence", destination: [contact.email], tags: { message_id: [String(message._id)] } }, failure: { timestamp: new Date().toISOString(), errorMessage: "fixture rendering rejection" } });
			assert.equal((await Campaign.findById(campaign._id)).stats.failed, 1);
		});
		await t.test("suppression persists before a failed metric write and replay repairs counters", async () => {
			const campaign = await Campaign.create({ newsletterId: newsletter._id, status: "sending", subject: "Safety", format: "markdown", markdown: "Text" });
			const contact = await Contact.create({ newsletterId: newsletter._id, email: "safety@example.invalid", status: "pending" });
			const rows = await Message.insertMany(Array.from({ length: 110 }, (_, i) => ({ kind: "campaign", campaignId: campaign._id, newsletterId: newsletter._id, contactId: i === 0 ? contact._id : new mongoose.Types.ObjectId(), email: `fixture-${i}@example.invalid`, status: "sent", ...(i < 100 && { sentAt: new Date() }), ...(i === 1 || i === 2 ? { bouncedAt: new Date() } : {}) })));
			const event = { eventType: "Bounce", mail: { messageId: "safety-event", destination: [contact.email], tags: { message_id: [String(rows[0]._id)] } }, bounce: { bounceType: "Permanent", timestamp: new Date().toISOString(), bouncedRecipients: [{ emailAddress: contact.email }] } };
			const failure = mock.method(Campaign.collection, "updateOne", async () => { throw new Error("counter write failed"); });
			await assert.rejects(handleSesEvent(event), /counter write failed/);
			failure.mock.restore();
			assert.ok(await Suppression.exists({ email: contact.email }));
			assert.equal((await Contact.findById(contact._id)).status, "bounced");
			assert.ok((await Message.findById(rows[0]._id)).bouncedAt);
			await handleSesEvent(event);
			assert.equal((await Campaign.findById(campaign._id)).stats.bounced, 3);
			assert.equal((await campaignEvidence(Message.collection, campaign._id)).stats.sent, 100);
			await sendQueuedCampaignBatch(String(campaign._id));
			assert.equal((await Campaign.findById(campaign._id)).status, "paused");
		});
	} finally { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
});

test("generic signup callbacks enforce caps at dispatch", { skip: !uri, timeout: 30_000 }, async (t) => {
	const mongoUrl = new URL(uri);
	mongoUrl.pathname = `/mailcheap_audit_caps_${randomUUID().replaceAll("-", "")}`;
	process.env.MONGODB_URI = mongoUrl.href;
	process.env.SENDING_ENABLED = "true";
	process.env.SESSION_SECRET = "isolated-cap-secret-with-at-least-32-characters";
	const [{ queueWelcomeEmail, queueConfirmationEmail, sendPendingConfirmation }, { default: Contact }, { default: Newsletter }, { default: Message }, { default: Suppression }] = await Promise.all([
		import("../lib/sending.js"), import("../models/Contact.js"), import("../models/Newsletter.js"), import("../models/Message.js"), import("../models/Suppression.js"),
	]);
	await mongoose.connect(process.env.MONGODB_URI);
	await Promise.all([Contact.createIndexes(), Newsletter.createIndexes(), Message.createIndexes(), Suppression.createIndexes()]);
	try {
		await t.test("two queued welcomes cannot spend the last newsletter slot twice", async () => {
			const newsletter = await Newsletter.create({ name: "Welcome cap", slug: "welcome-cap", fromEmail: "audit@example.invalid", requireConfirmation: false, welcome: { enabled: true, subject: "Welcome", markdown: "Fixture" } });
			await Message.insertMany(Array.from({ length: 99 }, () => ({ kind: "confirmation", newsletterId: newsletter._id, contactId: new mongoose.Types.ObjectId(), email: `${randomUUID()}@example.invalid`, status: "sent", attemptedAt: new Date(), sentAt: new Date() })));
			const contacts = await Contact.create([0, 1].map(() => ({ newsletterId: newsletter._id, email: `${randomUUID()}@example.invalid`, status: "active" })));
			let sends = 0;
			setSender(async () => { sends++; return { sesMessageId: randomUUID() }; });
			const original = Message.updateOne.bind(Message);
			let delayed = false;
			const slowClaim = mock.method(Message, "updateOne", async (...args) => {
				if (!delayed && args[1]?.$set?.attemptedAt) { delayed = true; await new Promise((resolve) => setTimeout(resolve, 300)); }
				return original(...args);
			});
			let outcomes;
			try {
				const alternate = await import(`../lib/sending.js?cap=${randomUUID()}`);
				outcomes = await Promise.all([queueWelcomeEmail({ newsletter, contact: contacts[0] }), alternate.queueWelcomeEmail({ newsletter, contact: contacts[1] })]);
			}
			finally { slowClaim.mock.restore(); }
			assert.equal(sends, 1);
			assert.equal(await Message.countDocuments({ newsletterId: newsletter._id, attemptedAt: { $gte: new Date(Date.now() - 600_000) }, status: { $ne: "failed" } }), 100);
			assert.ok(outcomes.some(({ deferUntil }) => deferUntil instanceof Date));
		});
		await t.test("concurrent legacy confirmations share one contact cooldown", async () => {
			const newsletter = await Newsletter.create({ name: "Contact cap", slug: "contact-cap", fromEmail: "audit@example.invalid", requireConfirmation: true });
			const contact = await Contact.create({ newsletterId: newsletter._id, email: "legacy-cooldown@example.invalid", status: "pending" });
			let sends = 0;
			setSender(async () => { sends++; return { sesMessageId: randomUUID() }; });
			const outcomes = await Promise.all(Array.from({ length: 2 }, () => queueConfirmationEmail({ newsletter, contact })));
			assert.equal(sends, 1);
			assert.equal(await Message.countDocuments({ contactId: contact._id, attemptedAt: { $ne: null }, status: { $ne: "failed" } }), 1);
			assert.ok(outcomes.some(({ deferUntil }) => deferUntil instanceof Date));
		});
		await t.test("dispatch deferral updates a managed intent after its preflight passed", async () => {
			const newsletter = await Newsletter.create({ name: "Managed cap", slug: "managed-cap", fromEmail: "audit@example.invalid", requireConfirmation: true });
			await Message.insertMany(Array.from({ length: 99 }, () => ({ kind: "confirmation", newsletterId: newsletter._id, contactId: new mongoose.Types.ObjectId(), email: `${randomUUID()}@example.invalid`, status: "sent", attemptedAt: new Date(), sentAt: new Date() })));
			const store = createSignupStore(Contact.collection, Suppression.collection);
			const accepted = await store.accept({ newsletterId: newsletter._id, email: "managed-cap@example.invalid", requestId: randomUUID(), consentedAt: new Date() });
			const original = Message.collection.updateOne.bind(Message.collection);
			let inserted = false;
			const lateClaim = mock.method(Message.collection, "updateOne", async (...args) => {
				if (!inserted && args[1]?.$setOnInsert?.confirmationRequestId === accepted.requestId) {
					inserted = true;
					await Message.collection.insertOne({ kind: "confirmation", newsletterId: newsletter._id, contactId: new mongoose.Types.ObjectId(), email: "late-claim@example.invalid", status: "sent", attemptedAt: new Date(), sentAt: new Date() });
				}
				return original(...args);
			});
			let sends = 0;
			setSender(async () => { sends++; return { sesMessageId: randomUUID() }; });
			let outcome;
			try { outcome = await sendPendingConfirmation({ contactId: accepted.id, requestId: accepted.requestId }); }
			finally { lateClaim.mock.restore(); }
			assert.equal(sends, 0);
			assert.ok(outcome.deferUntil instanceof Date);
			assert.equal(outcome.retry, undefined);
			const contact = await Contact.findById(accepted.id);
			assert.equal(+contact.confirmation.availableAt, +outcome.deferUntil);
			assert.equal(contact.confirmation.state, "needed");
			assert.equal((await Message.findOne({ contactId: accepted.id })).attemptedAt, undefined);
		});
		await t.test("definite SES rejection releases capacity for another generic callback", async () => {
			const newsletter = await Newsletter.create({ name: "Rejected cap", slug: "rejected-cap", fromEmail: "audit@example.invalid", requireConfirmation: false, welcome: { enabled: true, subject: "Welcome", markdown: "Fixture" } });
			await Message.insertMany(Array.from({ length: 99 }, () => ({ kind: "confirmation", newsletterId: newsletter._id, contactId: new mongoose.Types.ObjectId(), email: `${randomUUID()}@example.invalid`, status: "sent", attemptedAt: new Date(), sentAt: new Date() })));
			await Message.insertMany(Array.from({ length: 3 }, () => ({ kind: "confirmation", newsletterId: newsletter._id, contactId: new mongoose.Types.ObjectId(), email: `${randomUUID()}@example.invalid`, status: "failed", attemptedAt: new Date() })));
			const contacts = await Contact.create([0, 1].map(() => ({ newsletterId: newsletter._id, email: `${randomUUID()}@example.invalid`, status: "active" })));
			let calls = 0;
			setSender(async () => { if (++calls === 1) throw Object.assign(new Error("fixture rejection"), { name: "TooManyRequestsException" }); return { sesMessageId: randomUUID() }; });
			assert.equal((await queueWelcomeEmail({ newsletter, contact: contacts[0] })).retry, true);
			assert.equal((await queueWelcomeEmail({ newsletter, contact: contacts[1] })).sent, 1);
			assert.equal(calls, 2);
			assert.equal(await Message.countDocuments({ newsletterId: newsletter._id, attemptedAt: { $ne: null }, status: { $ne: "failed" } }), 100);
		});
		await t.test("independent sending modules share the process send rate", async () => {
			const { LIMITS } = await import("../lib/config.js");
			const previousRate = LIMITS.sendRatePerSecond;
			let modules;
			try {
				LIMITS.sendRatePerSecond = 1;
				modules = await Promise.all([0, 1].map(() => import(`../lib/sending.js?rate=${randomUUID()}`)));
			} finally { LIMITS.sendRatePerSecond = previousRate; }
			const newsletters = await Newsletter.create([0, 1].map((n) => ({ name: `Rate ${n}`, slug: `rate-${n}`, fromEmail: "audit@example.invalid", requireConfirmation: false, welcome: { enabled: true, subject: "Welcome", markdown: "Fixture" } })));
			const contacts = await Contact.create(newsletters.map(({ _id }) => ({ newsletterId: _id, email: `${randomUUID()}@example.invalid`, status: "active" })));
			const attempts = [];
			setSender(async () => { attempts.push(Date.now()); return { sesMessageId: randomUUID() }; });
			const outcomes = await Promise.all(modules.map(({ queueWelcomeEmail }, i) => queueWelcomeEmail({ newsletter: newsletters[i], contact: contacts[i] })));
			assert.ok(outcomes.every(({ sent }) => sent === 1));
			assert.equal(attempts.length, 2);
			assert.ok(attempts[1] - attempts[0] >= 700, "one-per-second slots remain spaced across module instances");
		});
	} finally { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
});
