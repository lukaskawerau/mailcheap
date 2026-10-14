import "server-only";
import { connectDb } from "@/lib/db";
import { assertJobSecret } from "./jobs/auth.js";
import { createJobQueue, JOB_COLLECTION } from "./jobs/queue.js";

let ready;

export async function getJobQueue() {
	assertJobSecret();
	ready ??= (async () => {
		const mongoose = await connectDb();
		const queue = createJobQueue(mongoose.connection.db.collection(JOB_COLLECTION));
		await queue.ensureIndexes();
		return queue;
	})();
	try { return await ready; }
	catch (error) { ready = undefined; throw error; }
}
