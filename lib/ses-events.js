import "server-only";
import { sendAlert } from "@/lib/alerts";
import { withEngagement } from "@/lib/cleanup";
import { connectDb } from "@/lib/db";
import { reconcileMessageCounters } from "./message-stats.js";
import { getSesEventPlan, getTrackingPlan } from "@/lib/ses-event-mapping";
import { isLikelyScanner } from "@/lib/tracking";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Event from "@/models/Event";
import Message from "@/models/Message";
import Suppression from "@/models/Suppression";

export { getSesEventPlan } from "@/lib/ses-event-mapping";

// Every send produces a delivery event; storing those raw would fill a small cluster within months.
const RECORDED_EVENT_TYPES = new Set(["Bounce", "Complaint", "Reject", "DeliveryDelay", "RenderingFailure"]);

// The message_id tag covers events that arrive before sesMessageId is saved.
async function findMessage({ sesMessageId, messageId }) {
	if (sesMessageId) {
		const message = await Message.findOne({ sesMessageId }).lean();
		if (message) return message;
	}
	if (!messageId) return null;

	const message = await Message.findById(messageId).lean();
	if (!message) return null;
	if (message.sesMessageId && sesMessageId && message.sesMessageId !== sesMessageId) return null;
	if (!message.sesMessageId && sesMessageId) {
		await Message.updateOne({ _id: message._id, sesMessageId: null }, { $set: { sesMessageId } });
	}
	return message;
}

async function applyMessageUpdates(message, plan) {
	for (const { field } of plan.firsts) await Message.updateOne({ _id: message._id, [field]: null }, { $set: { [field]: plan.occurredAt } });
	if (plan.status) await Message.updateOne({ _id: message._id, status: { $in: plan.status.from } }, { $set: { status: plan.status.to } });
	if (plan.error) await Message.updateOne({ _id: message._id }, { $set: { error: plan.error.slice(0, 500) } });
	if (message.contactId && plan.engagement) await Contact.updateOne({ _id: message.contactId }, withEngagement({ $max: plan.engagement }, plan.occurredAt));
	await reconcileMessageCounters(Message.collection, Campaign.collection, Contact.collection, message);
}

// Global: the address is never emailed again, from any newsletter.
async function suppress({ emails, reason, detail, contactStatus, contactStatusFrom }) {
	if (emails.length === 0) return;
	await Promise.all(
		emails.map((email) =>
			Suppression.updateOne(
				{ email },
				// A complaint outranks an earlier bounce or manual suppression.
				reason === "complaint"
					? { $set: { reason, detail } }
					: { $setOnInsert: { reason, detail } },
				{ upsert: true }
			)
		)
	);
	await Contact.updateMany(
		{ email: { $in: emails }, status: { $in: contactStatusFrom } },
		{ $set: { status: contactStatus }, $unset: { confirmation: "" } }
	);
}

// Mailcheap's own open pixel and click links update messages the way SES events do.
export async function recordEngagement({ messageId, type, userAgent }) {
	await connectDb();
	const message = await Message.findById(messageId).select("kind campaignId contactId sentAt").lean();
	if (!message) return;
	if (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt })) return;
	await applyMessageUpdates(message, getTrackingPlan(type));
}

export async function handleSesEvent(sesEvent) {
	const plan = getSesEventPlan(sesEvent);
	if (!plan) return { handled: false };

	await connectDb();
	if (plan.suppression) await suppress(plan.suppression);
	const message = await findMessage(plan);
	if (message) await applyMessageUpdates(message, plan);
	if (plan.suppression?.reason === "complaint") {
		await sendAlert({
			key: "complaints",
			title: "Spam complaint",
			detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
			path: message?.campaignId ? `/campaigns/${message.campaignId}` : "",
		});
	}

	if (RECORDED_EVENT_TYPES.has(plan.type)) {
		await Event.create({
			type: plan.type,
			sesMessageId: plan.sesMessageId,
			messageId: message?._id,
			campaignId: message?.campaignId,
			email: plan.email ?? message?.email,
			occurredAt: plan.occurredAt,
			data: plan.data,
		});
	}
	return { handled: true, messageId: message ? String(message._id) : null };
}
