import mongoose from "mongoose";

export const MESSAGE_STATUSES = [
	"queued",
	"sent",
	"delivered",
	"bounced",
	"complained",
	"failed",
	"suppressed",
];

const messageSchema = new mongoose.Schema(
	{
		kind: { type: String, enum: ["campaign", "last-chance", "welcome", "confirmation", "test"], required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		email: { type: String, required: true, lowercase: true, trim: true },
		provider: { type: String },
		status: { type: String, enum: MESSAGE_STATUSES, default: "queued" },
		sesMessageId: { type: String },
			confirmationRequestId: { type: String },
			confirmationGeneration: { type: String },
			attemptedAt: Date,
		error: { type: String },
		sentAt: Date,
		deliveredAt: Date,
		openedAt: Date,
		clickedAt: Date,
		bouncedAt: Date,
		complainedAt: Date,
	},
	{ timestamps: true }
);

// One email per contact per campaign, even if a send job is retried.
messageSchema.index(
	{ campaignId: 1, contactId: 1 },
	{ unique: true, partialFilterExpression: { kind: "campaign" } }
);
// And at most one last-chance email per contact per send.
messageSchema.index(
	{ campaignId: 1, contactId: 1, kind: 1 },
	{ unique: true, partialFilterExpression: { kind: "last-chance" } }
);
messageSchema.index({ contactId: 1, confirmationRequestId: 1 }, { unique: true, partialFilterExpression: { kind: "confirmation", confirmationRequestId: { $type: "string" } } });
messageSchema.index({ kind: 1, contactId: 1, attemptedAt: -1 });
messageSchema.index({ contactId: 1 });
messageSchema.index({ newsletterId: 1, kind: 1, attemptedAt: -1 });
messageSchema.index({ sesMessageId: 1 }, { sparse: true });
messageSchema.index({ kind: 1, createdAt: -1 });
// The overview's emails sent per hour.
messageSchema.index({ newsletterId: 1, sentAt: 1 });
messageSchema.index({ campaignId: 1, status: 1 });

export default mongoose.models.Message || mongoose.model("Message", messageSchema);
