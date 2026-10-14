import "server-only";
import { revalidatePath } from "next/cache";
import { sendAlert } from "@/lib/alerts";
import { revalidateArchive } from "@/lib/archive-data";
import { connectDb } from "@/lib/db";
import { getJobQueue } from "@/lib/jobs";
import { queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";

// Closer than this to the scheduled time, the send starts instead of waiting again.
const START_EARLY_MS = 60 * 1000;

export async function publishScheduledSend({ campaignId, scheduledAt }) {
	const job = await (await getJobQueue()).scheduleCampaign(campaignId, scheduledAt);
	if (job.status === "dead") throw new Error("Scheduled delivery job stopped after failures; an operator must retry it first");
}

// Runs when the worker delivers the job. A job whose campaign was rescheduled, unscheduled, sent or
// discarded since does nothing, so changing a schedule never needs to cancel the old job.
export async function runScheduledSend({ campaignId, scheduledAt }) {
	if (!isObjectIdString(String(campaignId)) || typeof scheduledAt !== "string") return { skipped: "invalid job" };

	await connectDb();
	const campaign = await Campaign.findById(campaignId).select("status scheduledAt subject").lean();
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== scheduledAt) {
		return { skipped: "not scheduled for this time anymore" };
	}
	if (campaign.scheduledAt.getTime() - Date.now() > START_EARLY_MS) {
		await publishScheduledSend({ campaignId, scheduledAt: campaign.scheduledAt });
		return { waiting: true };
	}

	try {
		const result = await queueCampaign(String(campaignId));
		revalidatePath("/campaigns");
		revalidatePath(`/campaigns/${campaignId}`);
		revalidateArchive();
		return { started: true, ...result };
	} catch (error) {
		// Only a campaign still waiting goes back to draft: one that started and then paused alerts on its own.
		const { modifiedCount } = await Campaign.updateOne(
			{ _id: campaignId, status: "scheduled" },
			{ $set: { status: "draft" }, $unset: { scheduledAt: 1 } }
		);
		if (modifiedCount) {
			await sendAlert({
				key: `scheduled-send-${campaignId}`,
				title: "Scheduled send didn't start",
				detail: `${error.message}. "${campaign.subject || "Untitled"}" is a draft again.`,
				path: `/campaigns/${campaignId}`,
				cooldownMinutes: 1,
			});
		}
		revalidatePath("/campaigns");
		return { failed: error.message };
	}
}
