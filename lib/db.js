import mongoose from "mongoose";

const cached = globalThis.__mailcheapMongoose ?? { connection: null, promise: null };
globalThis.__mailcheapMongoose = cached;

export async function connectDb() {
	if (cached.connection) return cached.connection;
	if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");

	cached.promise ??= mongoose.connect(process.env.MONGODB_URI, {
		maxPoolSize: 10,
		serverSelectionTimeoutMS: 5000,
	});
	const pending = cached.promise;
	try { cached.connection = await pending; }
	catch (error) {
		if (cached.promise === pending) cached.promise = null;
		throw error;
	}
	return cached.connection;
}
