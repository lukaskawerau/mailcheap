import { registerHooks } from "node:module";
const root = new URL("../../", import.meta.url);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
		if (specifier === "@/lib/ses") return nextResolve(new URL("fake-ses.mjs", import.meta.url).href, context);
		if (specifier === "@/lib/alerts") return nextResolve(new URL("fake-alerts.mjs", import.meta.url).href, context);
		if (specifier.startsWith("@/")) return nextResolve(new URL(`${specifier.slice(2)}.js`, root).href, context);
		return nextResolve(specifier, context);
	},
});
