import { getAppUrl } from "./config.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";

// Its own key, so an unsubscribe link can never confirm a subscription or the other way around.
const INFO = "mailcheap-confirm-v1";
const MANAGED_INFO = "mailcheap-confirm-v2";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createConfirmToken({ contactId, newsletterId, generation }, now = Date.now()) {
	return createContactToken({ info: generation ? MANAGED_INFO : INFO, contactId, newsletterId, generation }, now);
}

export function verifyConfirmToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: MANAGED_INFO, maxAgeMs: MAX_AGE_MS, now }) ?? verifyContactToken(token, { info: INFO, maxAgeMs: MAX_AGE_MS, now });
}

export function getConfirmUrl({ contactId, newsletterId, generation }) {
	return `${getAppUrl()}/confirm?token=${createConfirmToken({ contactId, newsletterId, generation })}`;
}
