---
summary: Immutable signup handoff, managed confirmation cycles and standalone Mongo recovery.
read_when:
  - Connecting a consent-recording site to Mailcheap
  - Changing signup retries, confirmation links or unsubscribe behavior
  - Investigating pending confirmations, throttles or uncertain delivery
---

# Deliver consent-backed signup requests

The authenticated `POST /api/v1/signup-requests` endpoint accepts a persisted consent request. Send
`newsletter`, normalized `email`, UUID `requestId`, and the original UTC ISO `consentedAt`. PostgreSQL
owns the exact consent wording. Reuse the same id and time after a timeout or failed acknowledgement.
Do not generate a new request merely to retry delivery.

A successful response contains `id`, current contact `status`, `created`, `requestId` and `outcome`.
The outcome is `queued`, `already-active`, `superseded` or `suppressed`. This acknowledges durable
provider acceptance, not email confirmation. New and reactivated contacts remain pending even when
an administrator disables the newsletter's generic `requireConfirmation` setting. Existing confirmed
active subscriptions remain active. The generic contacts API cannot reactivate managed contacts.

The endpoint rejects malformed input with 400, an invalid key with 401, an unknown newsletter with
404 and a changed consent timestamp for the current request id with 409. A caller treats these as
configuration or contract failures. Rate and service failures can retry the identical request.
The provider does not keep a second historical consent ledger. It trusts the authenticated site's
immutable database record and cannot detect every reuse of an ancient id against another contact.

## Order consent and withdrawal

The contact retains its greatest consent order and latest withdrawal time. The order compares
millisecond UTC consent time and then request id. A duplicate or older request changes no permission.
Consent at or before the latest withdrawal cannot resubscribe, even when the provider never saw that
request before. A genuinely later request can start a new pending cycle. Reconsent preserves the
withdrawal timestamp. This assumes the current shared VM clock. Consent more than 60 seconds in the
future is rejected. Review this contract before distributing these services across independent clocks.

Contact admission uses a journalled conditional write matching the current lifecycle state. It saves
both permission state and the pending confirmation obligation in that document. No replica set or
multi-document transaction is required. Pending, active and dormant contacts can unsubscribe. Reader,
administrator and imported opt-outs invalidate pending confirmation and advance the withdrawal barrier.
Repeated opt-outs also advance it while the contact is already unsubscribed, so a delayed intervening
consent cannot start another confirmation cycle.
Bounce and complaint suppression always block confirmation and sending.

## Recover confirmation work

The existing worker reconciles indexed pending contact intents and creates a signed confirmation job
when enqueueing was missed. Its key identifies contact and original request. Its payload contains
identifiers only. Dead jobs remain stopped until an operator fixes the cause and explicitly retries.
Sending disabled preserves the obligation and defers dispatch. It does not grant permission to send.

The intent predetermines one Message id. Retries reuse that id after a crash before insertion, after
insertion or after a lost response. The worker reserves one send slot, rereads current permission,
suppression and generation, and journal-claims the queued message immediately before SES. Newer
intent or withdrawal cancels stale work. Settlement matches the exact request and generation.

The SES send client makes one SDK attempt. Definite throttling or rejection can retry the same row
within the job's bounded failure budget. A timeout, a lost acceptance response or a crash after the
claim leaves uncertain delivery. It never creates a new automatic attempt. Review signed provider
evidence before recovery. A positively accepted message can settle its intent after an acknowledgement
failure. Existing worker health checks flag uncertain message claims after 15 minutes.

Signup caps count accepted or uncertain dispatch claims. Definite SES rejections do not consume
capacity. Confirmation messages have a 10-minute contact cooldown and a rolling 24-hour cap of three.
Welcome and confirmation messages share the newsletter flood limit. Every path checks eligibility
after its send-slot wait. The single web process serializes each cap check and journalled claim, so
concurrent generic callbacks cannot reserve the same capacity. Module copies share both the claim
queue and send-slot clock through process state. Managed deferrals persist the next
eligible time and preserve the job failure budget. Generic callbacks return a deferral without adding
a welcome outbox. Three historical requests do not exhaust an address permanently. These limits
require the supported single-web-process deployment.

## Preserve link behavior

Managed confirmation links include the pending cycle's generation and expire 30 days after delivery.
Resends within that cycle preserve earlier valid links. Withdrawal invalidates the generation. Later
reconsent creates another generation, so an old confirmation cannot activate it. A persistent managed
marker prevents cancellation from making legacy links eligible again.

Legacy pending links work only for untouched legacy contacts with no managed marker or withdrawal.
Existing active contacts retain idempotent confirmation success. Existing unsubscribe link signatures
and their permanent lifetime remain unchanged. Preserve `SESSION_SECRET`.

## Verify without sending mail

Run Node 24 with an isolated standalone MongoDB and set `MAILCHEAP_TEST_MONGODB_URI`. Tests create
and remove only disposable `mailcheap_audit_` databases or randomly prefixed queue collections.
Use a test URI whose database name begins with `mailcheap_audit_` for the existing queue suite.
The delivery tests replace SES and alert transports. They never use live credentials or send mail.
Run the deployment overlay tests to retain its ICU UTC label normalization, then run lint and build.

The tests cover request order, concurrent insertion, withdrawal, legacy and managed links, outbox
reconciliation, crashes around deterministic Message writes, rolling deferrals, one SES attempt,
recipient rechecks and webhook counter recovery. Campaign safety uses positive Message evidence
instead of a pre-SES claim or a partially updated counter. Suppression persists before metrics and
optional alerts. A final unsubscribe and SES request still cannot share an atomic cross-service write.
