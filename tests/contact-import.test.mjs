import assert from "node:assert/strict";
import { test } from "node:test";
import { getContactWrites, getStatusChanges } from "../lib/contact-import.js";

const newsletterId = "74f1a2b3c4d5e6f7a8b9c0d2";
const subscribedAt = new Date("2026-10-08T09:00:00.000Z");

// Rows as sanitizeImportRow hands them over, one per status a CSV file can map to.
const contacts = [
	{ email: "new@example.com", status: "active", subscribedAt, openRate: 0.5 },
	{ email: "left@example.com", status: "unsubscribed" },
	{ email: "left-too@example.com", status: "unsubscribed" },
	{ email: "bounced@example.com", status: "bounced" },
	{ email: "cold@example.com", status: "dormant", emailsReceived: 9, openRate: 0, clickRate: 0 },
];

test("rows add the contacts a newsletter doesn't have and only make statuses stricter", () => {
	const writes = getContactWrites({ newsletterId, contacts, source: "import" });
	assert.equal(writes.length, contacts.length);
	assert.ok(writes.every(({ updateOne }) => updateOne.upsert === true));
	assert.deepEqual(writes[0].updateOne.filter, { newsletterId, email: "new@example.com" });
	assert.deepEqual(writes[0].updateOne.update, {
		$setOnInsert: { status: "active", source: "import", subscribedAt },
		$set: { "imported.openRate": 0.5 },
	});
	assert.ok(writes[1].updateOne.update.$setOnInsert.unsubscribedAt instanceof Date);

	assert.deepEqual(getStatusChanges(contacts), [
		{ status: "unsubscribed", emails: ["left@example.com", "left-too@example.com"], replaces: ["active", "dormant", "pending", "unsubscribed"] },
		{ status: "bounced", emails: ["bounced@example.com"], replaces: ["active", "dormant", "unsubscribed"] },
		{ status: "dormant", emails: ["cold@example.com"], replaces: ["active"] },
	]);
});

test("imports cannot activate contacts and explicit opt-out cancels pending confirmation", () => {
	const writes = getContactWrites({ newsletterId, contacts, source: "import" });
	for (const { updateOne } of writes) {
		assert.ok(Object.keys(updateOne.update.$set ?? {}).every((key) => key.startsWith("imported.")));
	}
	for (const { status, replaces } of getStatusChanges(contacts)) {
		assert.notEqual(status, "active");
		assert.equal(replaces.includes("pending"), status === "unsubscribed");
	}
});
