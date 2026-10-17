import { randomUUID } from "node:crypto";

export const JOB_COLLECTION = "deliveryjobs";
export const JOB_PATHS = { campaign: "/api/jobs/send-batch", scheduled: "/api/jobs/send-scheduled", confirmation: "/api/jobs/send-confirmation" };
export const LEASE_MS = 300_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const OBJECT_ID = /^[a-f0-9]{24}$/;
const WRITE = { writeConcern: { w: 1, j: true } };

function jobData(kind, payload) {
	if (kind === "confirmation") {
		if (!OBJECT_ID.test(payload?.contactId) || !/^[a-f0-9-]{36}$/.test(payload?.requestId)) throw new Error("Invalid confirmation job");
		const body = JSON.stringify({ contactId: payload.contactId, requestId: payload.requestId });
		return { key: `confirmation:${payload.contactId}:${payload.requestId}`, body };
	}
	if (!JOB_PATHS[kind] || !OBJECT_ID.test(payload?.campaignId)) throw new Error("Invalid campaign job");
	const body = { campaignId: payload.campaignId };
	if (kind === "scheduled") {
		const at = new Date(payload.scheduledAt);
		if (!Number.isFinite(at.getTime()) || at.toISOString() !== payload.scheduledAt) throw new Error("Invalid schedule");
		body.scheduledAt = at.toISOString();
	}
	return { key: `${kind}:${body.campaignId}${body.scheduledAt ? `:${body.scheduledAt}` : ""}`, body: JSON.stringify(body) };
}

// A successful partial batch yields to other due campaigns. The sending switch defers a job without
// exhausting its retry budget. Only transport/provider failures use bounded exponential backoff.
export function jobOutcome(status, failures, random = Math.random) {
	if (status === 202) return { status: "queued", delay: 0, failures: 0 };
	if (status >= 200 && status < 300) return { status: "completed", failures: 0 };
	if (status === 409) return { status: "queued", delay: 60_000, failures };
	const next = failures + 1;
	const permanent = status >= 400 && status < 500 && ![408, 425, 429].includes(status);
	return {
		status: permanent || next >= MAX_FAILURES ? "dead" : "queued",
		failures: next,
		delay: Math.round(Math.min(30 * 60_000, 5000 * 2 ** (next - 1)) * (0.8 + random() * 0.4)),
	};
}

// Native Mongo operations also work on a standalone server: no replica set or multi-document
// transaction is needed. Every acknowledgement is fenced by the current, unexpired lease token.
export function createJobQueue(collection, { now = () => new Date(), leaseMs = LEASE_MS, random = Math.random } = {}) {
	function owned(job) {
		return { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: now() } };
	}

	async function enqueue(kind, payload, availableAt = now()) {
		const { key, body } = jobData(kind, payload);
		const at = new Date(availableAt);
		if (!Number.isFinite(at.getTime())) throw new Error("Invalid job time");
		const date = now();
		// Completed campaign jobs can be reused when an editor resumes or extends a send. Dead jobs
		// require an explicit operator retry; reconciliation must never erase their failure history.
		await collection.updateOne({ key, status: "completed" }, {
			$set: { status: "queued", availableAt: at, failures: 0, updatedAt: date },
			$unset: { expiresAt: "", completedAt: "", lastError: "" },
		}, WRITE);
		try {
			await collection.updateOne({ key }, { $setOnInsert: {
				_id: randomUUID(), key, kind, body, status: "queued", availableAt: at,
				attempts: 0, failures: 0, createdAt: date, updatedAt: date,
			} }, { ...WRITE, upsert: true });
		} catch (error) {
			if (error.code !== 11000) throw error; // Another producer inserted the same unique job.
		}
		return collection.findOne({ key });
	}

	return {
		async ensureIndexes() {
			await collection.createIndexes([
				{ key: { key: 1 }, unique: true, name: "job_key" },
				{ key: { status: 1, availableAt: 1 }, name: "due_jobs" },
				{ key: { status: 1, leaseUntil: 1 }, name: "expired_leases" },
				{ key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "completed_retention" },
			], WRITE);
		},
		enqueueConfirmation(contactId, requestId, availableAt) { return enqueue("confirmation", { contactId: String(contactId), requestId }, availableAt); },
		enqueueCampaign(campaignId) { return enqueue("campaign", { campaignId: String(campaignId) }); },
		scheduleCampaign(campaignId, scheduledAt) {
			return enqueue("scheduled", { campaignId: String(campaignId), scheduledAt: scheduledAt.toISOString() }, scheduledAt);
		},
		async claim() {
			const date = now();
			return collection.findOneAndUpdate({ $or: [
				{ status: "queued", availableAt: { $lte: date } },
				{ status: "running", leaseUntil: { $lte: date } },
			] }, {
				$set: { status: "running", leaseToken: randomUUID(), leaseUntil: new Date(date.getTime() + leaseMs), updatedAt: date },
				$inc: { attempts: 1 },
			}, { ...WRITE, sort: { availableAt: 1, _id: 1 }, returnDocument: "after", includeResultMetadata: false });
		},
		async renew(job) {
			const result = await collection.updateOne(owned(job), { $set: { leaseUntil: new Date(now().getTime() + leaseMs), updatedAt: now() } }, WRITE);
			return result.modifiedCount === 1;
		},
		async owns(job, kind, body) {
			return Boolean(await collection.findOne({ ...owned(job), kind, body }, { projection: { _id: 1 } }));
		},
		async acknowledge(job, httpStatus, deferUntil) {
			const date = now();
			const outcome = deferUntil ? { status: "queued", failures: job.failures, delay: Math.max(1000, +new Date(deferUntil) - +date) } : jobOutcome(httpStatus, job.failures, random);
			const fields = { status: outcome.status, failures: outcome.failures, updatedAt: date };
			if (outcome.status === "completed") {
				fields.completedAt = date;
				fields.expiresAt = new Date(date.getTime() + RETENTION_MS);
			} else {
				fields.availableAt = new Date(date.getTime() + outcome.delay);
				if (![202, 409].includes(httpStatus)) fields.lastError = httpStatus ? `http-${httpStatus}` : "transport-error";
			}
			const result = await collection.updateOne(owned(job), {
				$set: fields,
				$unset: { leaseToken: "", leaseUntil: "", ...([200, 202, 204].includes(httpStatus) ? { lastError: "" } : {}) },
			}, WRITE);
			return { acknowledged: result.modifiedCount === 1, status: outcome.status };
		},
		async retryFailed(id) {
			const result = await collection.updateOne({ _id: id, status: "dead" }, {
				$set: { status: "queued", failures: 0, availableAt: now(), updatedAt: now() },
				$unset: { lastError: "" },
			}, WRITE);
			return result.modifiedCount === 1;
		},
		async counts() {
			const rows = await collection.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
			return Object.fromEntries(rows.map(({ _id, count }) => [_id, count]));
		},
		async failed() {
			return collection.find({ status: "dead" }, { projection: {
				_id: 1, key: 1, kind: 1, attempts: 1, failures: 1, lastError: 1, updatedAt: 1,
			} }).sort({ updatedAt: -1 }).limit(50).toArray();
		},
	};
}
