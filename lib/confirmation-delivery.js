import { LIMITS } from "./config.js";

const WRITE = { writeConcern: { w: 1, j: true } };
const COOLDOWN_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function hasSendEvidence(message) {
	return Boolean(message?.sentAt || message?.sesMessageId || message?.deliveredAt || message?.bouncedAt || message?.complainedAt);
}

export async function signupEligibility(messages, message, now = new Date()) {
	const [recent, newsletter] = await Promise.all([
		message.kind === "confirmation" ? messages.find({ kind: "confirmation", contactId: message.contactId, attemptedAt: { $gt: new Date(+now - DAY_MS) }, status: { $ne: "failed" } }).sort({ attemptedAt: -1 }).limit(3).toArray() : [],
		messages.find({ kind: { $in: ["confirmation", "welcome"] }, newsletterId: message.newsletterId, attemptedAt: { $gt: new Date(+now - COOLDOWN_MS) }, status: { $ne: "failed" } }).sort({ attemptedAt: -1 }).limit(LIMITS.welcomeEmailsPer10Minutes).toArray(),
	]);
	const newsletterCapped = newsletter.length >= LIMITS.welcomeEmailsPer10Minutes;
	const availableAt = new Date(Math.max(+now, recent[0] ? +recent[0].attemptedAt + COOLDOWN_MS : 0, recent.length >= 3 ? +recent.at(-1).attemptedAt + DAY_MS : 0, newsletterCapped ? +newsletter.at(-1).attemptedAt + COOLDOWN_MS : 0));
	return { availableAt, newsletterCapped };
}

export async function processConfirmation({ contactId, requestId }, { contacts, messages, sendBatch, sending, now = () => new Date() }) {
	const contact = await contacts.findOne({ _id: contactId, status: "pending", "confirmation.requestId": requestId });
	if (!contact || contact.confirmation.state !== "needed") return { skipped: "confirmation no longer needed" };
	const intent = contact.confirmation;
	const matching = { _id: contact._id, status: "pending", "confirmation.requestId": requestId, "confirmation.generation": intent.generation, "confirmation.messageId": intent.messageId };
	async function settle(state) {
		await contacts.updateOne(matching, { $set: { "confirmation.state": state, updatedAt: now() } }, WRITE);
		return { [state]: true };
	}
	async function defer(at) {
		await contacts.updateOne(matching, { $set: { "confirmation.availableAt": at, updatedAt: now() } }, WRITE);
		return { deferUntil: at };
	}
	let message = await messages.findOne({ _id: intent.messageId });
	if (hasSendEvidence(message)) return settle("sent");
	if (message?.status === "sent") return settle("uncertain");
	if (!sending()) return defer(new Date(+now() + 60_000));
	if (+intent.availableAt > +now()) return { deferUntil: intent.availableAt };
	const eligible = await signupEligibility(messages, { kind: "confirmation", contactId: contact._id, newsletterId: contact.newsletterId }, now());
	if (+eligible.availableAt > +now()) return defer(eligible.availableAt);
	await messages.updateOne({ _id: intent.messageId }, { $setOnInsert: {
		kind: "confirmation", newsletterId: contact.newsletterId, contactId: contact._id, email: contact.email,
		confirmationRequestId: requestId, confirmationGeneration: intent.generation, status: "queued", createdAt: now(), updatedAt: now(),
	} }, { ...WRITE, upsert: true });
	await messages.updateOne({ _id: intent.messageId, status: "failed" }, { $set: { status: "queued" }, $unset: { attemptedAt: "" } }, WRITE);
	const outcome = await sendBatch([String(intent.messageId)]);
	if (outcome?.deferUntil) return defer(outcome.deferUntil);
	message = await messages.findOne({ _id: intent.messageId });
	if (hasSendEvidence(message)) return settle("sent");
	if (message?.status === "sent") return settle("uncertain");
	if (message?.status === "suppressed") return settle("sent");
	return { retry: true };
}
