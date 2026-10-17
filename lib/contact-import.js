import { withdrawalUpdate } from "./signup-requests.js";
import Contact from "../models/Contact.js";
import Suppression from "../models/Suppression.js";
import { STATUS_RANK, sanitizeImportRow } from "./csv-import.js";

const SUPPRESSION_REASONS = { bounced: "bounce", complained: "complaint" };

function weakerStatuses(status) {
	return Object.keys(STATUS_RANK).filter((key) => STATUS_RANK[key] < STATUS_RANK[status]);
}

// One upsert per contact: new contacts take the file's status, existing ones keep theirs.
export function getContactWrites({ newsletterId, contacts, source }) {
	return contacts.map(({ email, status, subscribedAt, emailsReceived, openRate, clickRate }) => {
		const imported = Object.entries({ emailsReceived, openRate, clickRate }).filter(
			([, value]) => value !== undefined
		);
		return {
			updateOne: {
				filter: { newsletterId, email },
				update: {
					$setOnInsert: {
						status,
						source,
						subscribedAt: subscribedAt ?? new Date(),
						...(status === "unsubscribed" && { unsubscribedAt: new Date() }),
					},
					...(imported.length > 0 && {
						$set: Object.fromEntries(imported.map(([key, value]) => [`imported.${key}`, value])),
					}),
				},
				upsert: true,
			},
		};
	});
}

// Imported opt-outs cancel pending confirmation. Imports never activate existing contacts.
export function getStatusChanges(contacts) {
	return Object.entries(Object.groupBy(contacts, ({ status }) => status))
		.filter(([status]) => status !== "active")
		.map(([status, group]) => ({
			status,
			emails: group.map(({ email }) => email),
			replaces: status === "unsubscribed" ? [...weakerStatuses(status), "pending", "unsubscribed"] : weakerStatuses(status),
		}));
}

// Never deletes and never moves a contact back to a weaker status: an unsubscribe, bounce or
// complaint always wins.
export async function importContactRows({ newsletterId, rows, source = "import" }) {
	const contacts = [
		...new Map(rows.map(sanitizeImportRow).filter(Boolean).map((row) => [row.email, row])).values(),
	];
	if (contacts.length === 0) return { created: 0, existing: 0, invalid: rows.length };

	const result = await Contact.bulkWrite(getContactWrites({ newsletterId, contacts, source }), { ordered: false });

	const changes = getStatusChanges(contacts);
	for (const { status, emails, replaces } of changes) {
		await Contact.updateMany(
			{ newsletterId, email: { $in: emails }, status: { $in: replaces } },
			status === "unsubscribed" ? withdrawalUpdate() : { $set: { status }, $unset: { confirmation: "" } }
		);
	}

	const suppressed = changes.filter(({ status }) => SUPPRESSION_REASONS[status]);
	if (suppressed.length > 0) {
		await Suppression.bulkWrite(
			suppressed.flatMap(({ status, emails }) =>
				emails.map((email) => ({
					updateOne: {
						filter: { email },
						update: { $setOnInsert: { reason: SUPPRESSION_REASONS[status], detail: source } },
						upsert: true,
					},
				}))
			),
			{ ordered: false }
		);
	}

	return {
		created: result.upsertedCount,
		existing: result.matchedCount,
		invalid: rows.length - contacts.length,
	};
}
