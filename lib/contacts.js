import { randomUUID } from "node:crypto";
import { withEngagement } from "./cleanup.js";
import Contact from "../models/Contact.js";
import Newsletter from "../models/Newsletter.js";
import Suppression from "../models/Suppression.js";
import { createSignupStore } from "./signup-requests.js";

const signupStore = createSignupStore(Contact.collection, Suppression.collection);
export const acceptSignupRequest = (input) => signupStore.accept(input);
export const withdrawContact = (input) => signupStore.withdraw(input);

// Newsletters in creation order with their active contacts, counted from the index in the same round trip.
export function listNewslettersWithActiveCounts(fields) {
	return Newsletter.aggregate([
		{ $sort: { createdAt: 1 } },
		...(fields ? [{ $project: Object.fromEntries(fields.split(" ").map((field) => [field, 1])) }] : []),
		{
			$lookup: {
				from: Contact.collection.collectionName,
				localField: "_id",
				foreignField: "newsletterId",
				pipeline: [{ $match: { status: "active" } }, { $count: "count" }],
				as: "active",
			},
		},
		{ $set: { activeCount: { $ifNull: [{ $first: "$active.count" }, 0] } } },
		{ $unset: "active" },
	]);
}

// Only an explicit resubscribe reverses an opt-out; bounces and complaints never reverse.
const REACTIVATABLE_STATUSES = ["unsubscribed", "dormant"];
const SUPPRESSED_STATUSES = { bounce: "bounced", complaint: "complained", manual: "unsubscribed" };

export async function upsertContact({ newsletter, email, source, resubscribe }) {
	const joinStatus = newsletter.requireConfirmation ? "pending" : "active";
	const suppression = await Suppression.findOne({ email }).select({ reason: 1 }).lean();
	const status = suppression ? (SUPPRESSED_STATUSES[suppression.reason] ?? "unsubscribed") : joinStatus;
	const now = new Date();
	const result = await Contact.findOneAndUpdate(
		{ newsletterId: newsletter._id, email },
		{ $setOnInsert: { status, source, subscribedAt: now } },
		{ upsert: true, returnDocument: "after", includeResultMetadata: true }
	).lean();
	const created = !result.lastErrorObject?.updatedExisting;
	const contact = result.value;

	if (created || !resubscribe || suppression || contact.signupManaged) return { contact, created };
	// Signing up again is a sign of life, and brings back a contact who left or went dormant.
	if (contact.status === "active") {
		await Contact.updateOne({ _id: contact._id }, withEngagement());
		return { contact, created };
	}
	if (!REACTIVATABLE_STATUSES.includes(contact.status)) return { contact, created };
	if (newsletter.requireConfirmation) {
		const accepted = await signupStore.accept({ newsletterId: newsletter._id, email, requestId: randomUUID(), consentedAt: new Date() });
		return { contact: await Contact.findById(accepted.id).lean(), created };
	}
	const reactivated = await Contact.findOneAndUpdate(
		{ _id: contact._id, status: { $in: REACTIVATABLE_STATUSES } },
		withEngagement({ $set: { status: joinStatus, subscribedAt: new Date() } }),
		{ returnDocument: "after" }
	).lean();
	return { contact: reactivated ?? contact, created };
}

// The click on the confirmation link. A contact that already confirmed stays as it is.
export const confirmContact = (reference) => signupStore.confirm(reference);

// The "Yes, keep sending it" click in the last-chance email. It also brings back a contact who went
// dormant; unsubscribes, bounces and complaints stay as they are.
export async function keepContact({ contactId, newsletterId }) {
	const contact = await Contact.findOne({ _id: contactId, newsletterId }).select({ email: 1, status: 1 }).lean();
	if (!contact || !["active", "dormant"].includes(contact.status)) return null;
	if (contact.status === "dormant" && (await Suppression.exists({ email: contact.email }))) return null;
	return Contact.findOneAndUpdate(
		{ _id: contact._id, status: { $in: ["active", "dormant"] } },
		withEngagement({ $set: { status: "active" } }),
		{ returnDocument: "after" }
	).lean();
}
