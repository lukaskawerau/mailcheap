function countIf(field) {
	return { $sum: { $cond: [{ $gt: [`$${field}`, null] }, 1, 0] } };
}

export const MESSAGE_STATS_GROUP = {
	sent: countIf("sentAt"),
	delivered: countIf("deliveredAt"),
	opened: countIf("openedAt"),
	clicked: countIf("clickedAt"),
	bounced: countIf("bouncedAt"),
	complained: countIf("complainedAt"),
};

const POSITIVE_SEND = { $or: ["sentAt", "sesMessageId", "deliveredAt", "bouncedAt", "complainedAt"].map((field) => ({ $gt: [`$${field}`, null] })) };
const EVIDENCE_GROUP = { ...MESSAGE_STATS_GROUP, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }, sent: { $sum: { $cond: [POSITIVE_SEND, 1, 0] } } };

export async function campaignEvidence(messages, campaignId) {
	const rows = await messages.aggregate([
		{ $match: { campaignId, kind: { $in: ["campaign", "last-chance"] } } },
		{ $group: { _id: "$kind", ...EVIDENCE_GROUP } },
	]).toArray();
	return { stats: rows.find(({ _id }) => _id === "campaign") ?? {}, lastChance: rows.find(({ _id }) => _id === "last-chance") ?? {} };
}

export async function reconcileMessageCounters(messages, campaigns, contacts, message) {
	if (message.campaignId && ["campaign", "last-chance"].includes(message.kind)) {
		const counts = await campaignEvidence(messages, message.campaignId);
		const fields = {};
		for (const [path, values] of Object.entries(counts)) {
			for (const [field, count] of Object.entries(values)) {
				if (field !== "_id" && !(path === "lastChance" && ["opened", "clicked"].includes(field))) fields[`${path}.${field}`] = count;
			}
		}
		if (Object.keys(fields).length) await campaigns.updateOne({ _id: message.campaignId }, { $max: fields });
	}
	if (message.contactId) {
		const [counts] = await messages.aggregate([{ $match: { contactId: message.contactId } }, { $group: { _id: null, ...EVIDENCE_GROUP } }]).toArray();
		if (counts) await contacts.updateOne({ _id: message.contactId }, { $max: { "stats.sent": counts.sent, "stats.opens": counts.opened, "stats.clicks": counts.clicked } });
	}
}
