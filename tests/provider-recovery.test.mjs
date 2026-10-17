import "./fixtures/mail-runtime.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import mongoose from "mongoose";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
const { createSesSendClient } = await import("../lib/ses.js");

test("a rejected first Mongo connection is shared, cleared, and retried", async () => {
	const original = globalThis.__mailcheapMongoose;
	delete globalThis.__mailcheapMongoose;
	process.env.MONGODB_URI = "mongodb://127.0.0.1:27517/mailcheap_audit_connection";
	const { connectDb } = await import(`../lib/db.js?test=${randomUUID()}`);
	let attempts = 0;
	const connection = mock.method(mongoose, "connect", async () => {
		attempts++;
		if (attempts === 1) throw new Error("first connection rejected");
		return mongoose;
	});
	try {
		const first = await Promise.allSettled([connectDb(), connectDb()]);
		assert.ok(first.every(({ status }) => status === "rejected"));
		assert.equal(attempts, 1);
		assert.equal(await connectDb(), mongoose);
		assert.equal(await connectDb(), mongoose);
		assert.equal(attempts, 2);
	} finally { connection.mock.restore(); globalThis.__mailcheapMongoose = original; }
});

test("the SES send client makes one transport attempt after an ambiguous timeout", async () => {
	let attempts = 0;
	const client = createSesSendClient({
		region: "eu-central-1", credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
		requestHandler: { handle: async () => { attempts++; throw Object.assign(new Error("fixture timeout"), { name: "TimeoutError" }); }, destroy() {} },
	});
	try {
		assert.equal(await client.config.maxAttempts(), 1);
		await assert.rejects(client.send(new SendEmailCommand({ FromEmailAddress: "sender@example.invalid", Destination: { ToAddresses: ["reader@example.invalid"] }, Content: { Simple: { Subject: { Data: "Audit" }, Body: { Text: { Data: "Fixture" } } } } })), /fixture timeout/);
		assert.equal(attempts, 1);
	} finally { client.destroy(); }
});
