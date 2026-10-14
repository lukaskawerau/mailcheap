// Campaign state is the outbox. A crash between its state change and enqueue is repaired on startup
// and each minute. Paused/draft campaigns are never started by this pass, and dead jobs stay dead.
export async function reconcileCampaignJobs(campaigns, queue) {
	let reconciled = 0;
	for await (const campaign of campaigns.find({ status: { $in: ["sending", "scheduled"] } }, {
		projection: { _id: 1, status: 1, scheduledAt: 1 }, batchSize: 100,
	})) {
		if (campaign.status === "sending") await queue.enqueueCampaign(campaign._id);
		else if (campaign.scheduledAt instanceof Date && Number.isFinite(campaign.scheduledAt.getTime())) {
			await queue.scheduleCampaign(campaign._id, campaign.scheduledAt);
		}
		reconciled++;
	}
	return reconciled;
}
