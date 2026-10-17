import mongoose from "mongoose";

// pending: signed up to a newsletter that asks new subscribers to confirm, and hasn't yet.
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];

const contactSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		email: { type: String, required: true, lowercase: true, trim: true },
		status: { type: String, enum: CONTACT_STATUSES, default: "active" },
		source: { type: String, trim: true },
		subscribedAt: { type: Date, default: Date.now },
		confirmedAt: { type: Date },
			signupManaged: { type: Boolean },
			signup: { requestId: String, consentedAt: Date },
			confirmation: { generation: String, requestId: String, messageId: mongoose.Schema.Types.ObjectId, state: String, availableAt: Date },
		unsubscribedAt: { type: Date },
		lastSentAt: { type: Date },
		lastOpenAt: { type: Date },
		lastClickAt: { type: Date },
		// List cleanup (lib/cleanup.js): issues received since the last sign of life (open, click,
		// confirmation, signup, "keep sending it" click), when that was, and when the last-chance email went out.
		ignoredIssues: { type: Number },
		lastEngagedAt: { type: Date },
		lastChanceAt: { type: Date },
		stats: {
			sent: { type: Number, default: 0 },
			opens: { type: Number, default: 0 },
			clicks: { type: Number, default: 0 },
		},
		// From a CSV import: engagement on the previous platform, so sends reach the most engaged first.
		imported: {
			emailsReceived: { type: Number },
			openRate: { type: Number },
			clickRate: { type: Number },
		},
	},
	{ timestamps: true }
);

contactSchema.index({ newsletterId: 1, email: 1 }, { unique: true });
contactSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
contactSchema.index({ email: 1 });
contactSchema.index({ status: 1, "confirmation.state": 1, "confirmation.availableAt": 1 });
// The contacts list shows the newest subscribers first, with or without newsletter and status filters.
// It breaks ties by _id, which the index needs too: without it MongoDB sorts the whole list on every page.
contactSchema.index({ subscribedAt: -1, _id: -1 });
contactSchema.index({ status: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, status: 1, subscribedAt: -1, _id: -1 });
// The list cleanup totals in newsletter settings.
contactSchema.index({ newsletterId: 1, lastChanceAt: 1 }, { partialFilterExpression: { lastChanceAt: { $exists: true } } });

export default mongoose.models.Contact || mongoose.model("Contact", contactSchema);
