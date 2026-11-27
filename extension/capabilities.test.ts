// Public tool provenance and the hub's capability-report wire contract.
import { expect, test } from "bun:test";
import { bridge } from "./cataly";
import { ctxOf, fakePi, laneHub } from "./fakes";

type Frame = { readonly method: string; readonly params: { readonly session?: string; readonly nonstock?: readonly string[] } };

for (const { label, tools, expected } of [
	{ label: "no integrations", tools: [], expected: [] },
	{
		label: "MCP and extension integrations",
		tools: [
			{ name: "mcp__owner_search", source: "mcp", active: true },
			{ name: "owner_tool", source: "extension", active: true },
			{ name: "sdk_tool", source: "sdk", active: true },
			{ name: "future_builtin", source: "builtin", active: true },
			{ name: "cataly_lead", source: "extension", active: true },
			{ name: "mcp__disabled_search", source: "mcp", active: false },
			{ name: "disabled_extension", source: "extension", active: false },
		],
		expected: ["mcp__owner_search", "owner_tool", "sdk_tool"],
	},
]) {
	test(`accepted sessions report only live non-stock tools after hello: ${label}`, async () => {
		const pi = fakePi();
		const sent: Frame[] = [];
		for (const tool of tools) pi.inventory.push({ name: tool.name, sourceInfo: { source: tool.source } });
		pi.setActiveTools([...pi.active(), ...tools.filter(tool => tool.active).map(tool => tool.name)]);
		bridge(pi, { env: { CATALY_LAUNCH: "tok" }, connect: laneHub(sent, {}), uid: () => 1 });

		await pi.emit("session_start", {}, ctxOf(pi));

		expect(sent.slice(0, 2).map(frame => frame.method)).toEqual(["bridge.hello", "bridge.capabilities"]);
		expect(sent.filter(frame => frame.method === "bridge.capabilities").map(frame => frame.params))
			.toEqual([{ session: "s1", nonstock: expected }]);
	});
}

test("late registration reports once at the existing heartbeat, not again for unchanged or reordered tools", async () => {
	const pi = fakePi();
	const sent: Frame[] = [];
	const ticks: (() => void)[] = [];
	const ctx = { ...ctxOf(pi), setInterval: (fn: () => void) => (ticks.push(fn), 0) };
	bridge(pi, { env: { CATALY_LAUNCH: "tok" }, connect: laneHub(sent, {}), uid: () => 1 });
	await pi.emit("session_start", {}, ctx);

	pi.inventory.push({ name: "mcp__late_search", sourceInfo: { source: "mcp" } });
	pi.setActiveTools([...pi.active(), "mcp__late_search"]);
	for (const tick of ticks) tick();
	pi.setActiveTools([...pi.active()].reverse());
	for (const tick of ticks) tick();
	await pi.emit("turn_start", {}, ctx);

	expect(sent.filter(frame => frame.method === "bridge.capabilities").map(frame => frame.params))
		.toEqual([{ session: "s1", nonstock: [] }, { session: "s1", nonstock: ["mcp__late_search"] }]);
});

test("turn start reports newly active tools and removal without waiting for the heartbeat", async () => {
	const pi = fakePi();
	const sent: Frame[] = [];
	const ctx = ctxOf(pi);
	bridge(pi, { env: { CATALY_LAUNCH: "tok" }, connect: laneHub(sent, {}), uid: () => 1 });
	await pi.emit("session_start", {}, ctx);
	pi.inventory.push({ name: "owner_tool", sourceInfo: { source: "extension" } });

	pi.setActiveTools([...pi.active(), "owner_tool"]);
	await pi.emit("turn_start", {}, ctx);
	pi.setActiveTools(pi.active().filter(name => name !== "owner_tool"));
	await pi.emit("turn_start", {}, ctx);

	expect(sent.filter(frame => frame.method === "bridge.capabilities").map(frame => frame.params))
		.toEqual([
			{ session: "s1", nonstock: [] },
			{ session: "s1", nonstock: ["owner_tool"] },
			{ session: "s1", nonstock: [] },
		]);
});
