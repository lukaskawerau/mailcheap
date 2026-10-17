import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { connectDb } from "../lib/db.js";
import { assertJobSecret } from "../lib/jobs/auth.js";
import { dispatchJob } from "../lib/jobs/dispatch.js";
import { createJobQueue, JOB_COLLECTION } from "../lib/jobs/queue.js";
import { reconcileCampaignJobs, reconcileConfirmationJobs } from "../lib/jobs/reconcile.js";

const HEALTH_FILE = "/tmp/mailcheap-worker-health.json";
const command = process.argv[2] || "work";

async function main() {
	if (command === "health") {
		const state = JSON.parse(await readFile(HEALTH_FILE, "utf8"));
		if (Date.now() - state.at > 90_000 || !state.connected || state.dead || state.uncertain) throw new Error("Worker needs attention");
		return;
	}
	if (!["work", "status", "retry"].includes(command)) throw new Error("Usage: mail-worker.mjs [work|health|status|retry JOB_ID]");
	const secret = assertJobSecret();
	await connectDb();
	const db = mongoose.connection.db;
	const queue = createJobQueue(db.collection(JOB_COLLECTION));
	await queue.ensureIndexes();
	if (command === "retry") {
		if (!await queue.retryFailed(process.argv[3])) throw new Error("No failed job with that id");
		console.info(JSON.stringify({ retried: process.argv[3] }));
		return;
	}
	const uncertainFilter = {
		status: "sent", sentAt: { $exists: false }, sesMessageId: { $exists: false },
		updatedAt: { $lt: new Date(Date.now() - 15 * 60_000) },
	};
	async function status() {
		return { jobs: await queue.counts(), uncertain: await db.collection("messages").countDocuments({
			...uncertainFilter, updatedAt: { $lt: new Date(Date.now() - 15 * 60_000) },
		}) };
	}
	if (command === "status") { console.info(JSON.stringify({ ...await status(), failed: await queue.failed() })); return; }
	const appUrl = new URL(process.env.JOB_APP_URL || "http://127.0.0.1:3000");
	if (!["http:", "https:"].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== "/" || appUrl.search || appUrl.hash) {
		throw new Error("JOB_APP_URL must be an origin without credentials or a path");
	}
	const sending = process.env.SENDING_ENABLED === "true";
	let stopping = false;
	let nextReview = 0;
	let snapshot = { connected: true, dead: 0, uncertain: 0 };
	process.once("SIGTERM", () => { stopping = true; });
	process.once("SIGINT", () => { stopping = true; });
	async function heartbeat() { await writeFile(HEALTH_FILE, JSON.stringify({ ...snapshot, at: Date.now(), sending }), { mode: 0o600 }); }
	console.info(JSON.stringify({ worker: "started", sending }));
	while (!stopping) {
		try {
			if (Date.now() >= nextReview) {
				await reconcileCampaignJobs(db.collection("campaigns"), queue);
				await reconcileConfirmationJobs(db.collection("contacts"), queue);
				const state = await status();
				snapshot = { connected: true, dead: state.jobs.dead || 0, uncertain: state.uncertain };
				if (snapshot.dead || snapshot.uncertain) console.error(JSON.stringify({ worker: "needs-attention", ...snapshot }));
				nextReview = Date.now() + 60_000;
			}
			await heartbeat();
			const job = sending ? await queue.claim() : null;
			if (!job) { await delay(1000); continue; }
			const result = await dispatchJob(job, queue, { appUrl, secret, heartbeat });
			console.info(JSON.stringify({ jobId: job._id, kind: job.kind, ...result }));
		} catch {
			snapshot.connected = false;
			nextReview = 0;
			await heartbeat();
			console.error(JSON.stringify({ worker: "database-or-dispatch-error" }));
			await delay(5000);
		}
	}
	await writeFile(HEALTH_FILE, JSON.stringify({ at: 0, connected: false }), { mode: 0o600 });
}

try { await main(); }
catch (error) { console.error(`[mail-worker] ${command === "health" ? "Unhealthy" : error.name}`); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
