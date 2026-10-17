"use server";

import { after } from "next/server";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { queueWelcomeEmail } from "@/lib/sending";
import Newsletter from "@/models/Newsletter";

export async function confirmSubscription(token) {
	const reference = verifyConfirmToken(token);
	if (!reference) return { error: "invalid" };

	await connectDb();
	const { contact, confirmed } = await confirmContact(reference);
	if (contact?.status !== "active") return { error: "invalid" };

	if (confirmed && !contact.signupManaged && isSendingEnabled()) {
		const newsletter = await Newsletter.findById(reference.newsletterId).lean();
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		after(() =>
			queueWelcomeEmail({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Welcome email for ${contact._id} failed:`, error.message)
			)
		);
	}
	return { ok: true };
}
