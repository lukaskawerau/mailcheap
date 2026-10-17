import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-keys";
import { acceptSignupRequest } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { parseSignupRequest, SignupRequestError } from "@/lib/signup-requests";
import Newsletter from "@/models/Newsletter";

export async function POST(request) {
	const apiKey = await authenticateRequest(request);
	if (!apiKey) return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
	if (await isRateLimited({ name: "api-signup-requests", key: String(apiKey._id), limit: 600, window: "1 h" })) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
	let input;
	try { input = parseSignupRequest(await request.json()); }
	catch { return NextResponse.json({ error: "Invalid signup request" }, { status: 400 }); }
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug: input.newsletter }).select({ _id: 1 }).lean();
	if (!newsletter) return NextResponse.json({ error: "Newsletter not found" }, { status: 404 });
	try {
		const accepted = await acceptSignupRequest({ ...input, newsletterId: newsletter._id });
		return NextResponse.json(accepted, { status: accepted.created ? 201 : 200 });
	} catch (error) {
		if (error instanceof SignupRequestError && error.code === "request-conflict") return NextResponse.json({ error: error.code }, { status: 409 });
		throw error;
	}
}
