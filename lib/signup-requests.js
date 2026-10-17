import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { normalizeEmail, isPlainObject } from "./validation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE = { writeConcern: { w: 1, j: true } };
const BLOCKED = ["bounced", "complained"];
const SUPPRESSION_STATUS = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" };

export class SignupRequestError extends Error {
	constructor(code) { super(code); this.code = code; }
}

export function parseSignupRequest(body, now = new Date()) {
	if (!isPlainObject(body) || typeof body.newsletter !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.newsletter) || body.newsletter.length > 120) throw new SignupRequestError("invalid-newsletter");
	const email = normalizeEmail(body.email);
	if (!email || typeof body.requestId !== "string" || !UUID.test(body.requestId)) throw new SignupRequestError("invalid-request");
	if (typeof body.consentedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(body.consentedAt)) throw new SignupRequestError("invalid-consent-time");
	const consentedAt = new Date(body.consentedAt);
	if (!Number.isFinite(+consentedAt) || consentedAt.toISOString().slice(0, 19) !== body.consentedAt.slice(0, 19) || +consentedAt > +now + 60_000) throw new SignupRequestError("invalid-consent-time");
	return { newsletter: body.newsletter, email, requestId: body.requestId.toLowerCase(), consentedAt };
}

export function withdrawalUpdate(now = new Date()) {
	return { $set: { status: "unsubscribed", updatedAt: now }, $max: { unsubscribedAt: now }, $unset: { confirmation: "" } };
}

function order(left, right) {
	return +left.consentedAt - +right.consentedAt || left.requestId.localeCompare(right.requestId);
}

// The matching lifecycle snapshot fences concurrent withdrawal and newer consent.
function stateFilter(contact) {
	return { _id: contact._id, status: contact.status, signup: contact.signup ?? null, confirmation: contact.confirmation ?? null, unsubscribedAt: contact.unsubscribedAt ?? null };
}

export function createSignupStore(contacts, suppressions, { now = () => new Date() } = {}) {
	function reference(value) { return new mongoose.Types.ObjectId(String(value)); }
	function response(contact, input, created, outcome) {
		return { id: String(contact._id), status: contact.status, created, requestId: input.requestId, outcome };
	}
	function intent(input, generation = randomUUID()) {
		return { generation, requestId: input.requestId, messageId: new mongoose.Types.ObjectId(), state: "needed", availableAt: now() };
	}
	return {
		async accept(input) {
			const newsletterId = reference(input.newsletterId);
			const suppression = await suppressions.findOne({ email: input.email });
			const status = suppression ? SUPPRESSION_STATUS[suppression.reason] ?? "unsubscribed" : "pending";
			const initial = { _id: new mongoose.Types.ObjectId(), newsletterId, email: input.email, status,
				source: "ortskurier-consent-v2", subscribedAt: input.consentedAt, createdAt: now(), updatedAt: now(),
				signupManaged: true, signup: { requestId: input.requestId, consentedAt: input.consentedAt },
				...(!suppression && { confirmation: intent(input) }) };
			let result;
			try {
				result = await contacts.findOneAndUpdate({ newsletterId, email: input.email }, { $setOnInsert: initial }, { ...WRITE, upsert: true, returnDocument: "after", includeResultMetadata: true });
			} catch (error) {
				if (error.code !== 11000) throw error;
				result = { value: await contacts.findOne({ newsletterId, email: input.email }), lastErrorObject: { updatedExisting: true } };
			}
			let contact = result.value;
			const created = !result.lastErrorObject.updatedExisting;
			if (created) return response(contact, input, true, suppression ? "suppressed" : "queued");
			for (;;) {
				if (contact.signup?.requestId === input.requestId) {
					if (+contact.signup.consentedAt !== +input.consentedAt) throw new SignupRequestError("request-conflict");
					return response(contact, input, false, contact.status === "pending" && contact.confirmation?.state === "needed" ? "queued" : contact.status === "active" ? "already-active" : "superseded");
				}
				if (suppression || BLOCKED.includes(contact.status)) return response(contact, input, false, "suppressed");
				if ((contact.signup && order(input, contact.signup) <= 0) || (contact.unsubscribedAt && +input.consentedAt <= +contact.unsubscribedAt)) return response(contact, input, false, "superseded");
				const active = contact.status === "active";
				const update = { $set: { signupManaged: true, signup: { requestId: input.requestId, consentedAt: input.consentedAt }, updatedAt: now(),
					...(!active && { status: "pending", subscribedAt: input.consentedAt, confirmation: intent(input, contact.status === "pending" ? contact.confirmation?.generation : undefined) }) },
					...(!active && { $unset: { confirmedAt: "" } }) };
				const changed = await contacts.findOneAndUpdate(stateFilter(contact), update, { ...WRITE, returnDocument: "after" });
				if (changed) return response(changed, input, false, active ? "already-active" : "queued");
				contact = await contacts.findOne({ newsletterId, email: input.email });
				if (!contact) throw new SignupRequestError("contact-disappeared");
			}
		},
		async withdraw({ contactId, newsletterId }) {
			return contacts.findOneAndUpdate({ _id: reference(contactId), ...(newsletterId && { newsletterId: reference(newsletterId) }), status: { $in: ["pending", "active", "dormant", "unsubscribed"] } }, withdrawalUpdate(now()), { ...WRITE, returnDocument: "before" });
		},
		async confirm({ contactId, newsletterId, generation }) {
			const id = { _id: reference(contactId), newsletterId: reference(newsletterId) };
			const current = await contacts.findOne(id);
			if (!current || await suppressions.findOne({ email: current.email }) || BLOCKED.includes(current.status)) return { contact: null, confirmed: false };
			if (current.status === "active") return { contact: current, confirmed: false };
			const eligibility = generation ? { signupManaged: true, "confirmation.generation": generation } : { signupManaged: { $ne: true }, unsubscribedAt: { $exists: false } };
			const contact = await contacts.findOneAndUpdate({ ...id, status: "pending", ...eligibility }, { $set: { status: "active", confirmedAt: now(), lastEngagedAt: now(), ignoredIssues: 0, updatedAt: now() }, $unset: { confirmation: "", lastChanceAt: "" } }, { ...WRITE, returnDocument: "after" });
			return { contact: contact ?? await contacts.findOne(id), confirmed: Boolean(contact) };
		},
	};
}
