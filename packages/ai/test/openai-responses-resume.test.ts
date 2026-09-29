import { describe, expect, it } from "bun:test";
import type { ModelSpec } from "@oh-my-pi/pi-ai";
import {
	pollOpenAIResponsesResultForCompletion,
	streamOpenAIResponses,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const SOCKET_CLOSE =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

function makeModel(provider: "muse-code" | "openai"): Model<"openai-responses"> {
	return buildModel({
		id: provider === "muse-code" ? "muse-spark-1.3" : "gpt-5",
		name: "Test Model",
		api: "openai-responses",
		provider,
		baseUrl: provider === "muse-code" ? "https://api.meta.ai/v1" : "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	} as ModelSpec<"openai-responses">);
}

function sseFrame(payload: { type: string }): string {
	return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE body that delivers the created event and partial reasoning on the first
 * read, then fails the next read like a socket dropped mid-body. Pull-driven,
 * so the drop is ordered by the consumer, not a timer.
 */
function dyingSseBody(responseId: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const payload = [
		{
			type: "response.created",
			sequence_number: 0,
			response: { id: responseId, object: "response", status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			sequence_number: 1,
			item: { id: "rs_1", type: "reasoning", summary: [] },
		},
		{
			type: "response.reasoning_summary_text.delta",
			output_index: 0,
			item_id: "rs_1",
			sequence_number: 2,
			delta: "partial plan",
		},
	]
		.map(sseFrame)
		.join("");
	let delivered = false;
	return new ReadableStream({
		pull(controller) {
			if (!delivered) {
				delivered = true;
				controller.enqueue(encoder.encode(payload));
				return;
			}
			controller.error(new Error(SOCKET_CLOSE));
		},
	});
}

function completedResult(responseId: string): Record<string, unknown> {
	return {
		id: responseId,
		object: "response",
		status: "completed",
		output: [
			{ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "full resumed plan" }] },
			{
				id: "msg_1",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "adopted answer", annotations: [] }],
			},
		],
		usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
	};
}

interface DropScenario {
	fetchImpl: FetchImpl;
	posts: string[];
	gets: string[];
	postBodies: unknown[];
}

function dropScenario(responseId: string, pollResponses: Array<() => Response>): DropScenario {
	const posts: string[] = [];
	const gets: string[] = [];
	const postBodies: unknown[] = [];
	const fetchImpl = (async (url: unknown, init?: RequestInit) => {
		const target = String(url);
		if (target.endsWith("/responses")) {
			posts.push(target);
			postBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(dyingSseBody(responseId), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}
		gets.push(target);
		const next = pollResponses[Math.min(gets.length - 1, pollResponses.length - 1)];
		if (!next) throw new Error("Expected a scripted poll response");
		return next();
	}) as FetchImpl;
	return { fetchImpl, posts, gets, postBodies };
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] };
// Poll sleeps and transient-retry backoff go through the injectable wait seam.
const noWait = async (): Promise<void> => {};

describe("openai-responses socket-drop resume", () => {
	it("adopts the stored muse-code result instead of replaying the turn", async () => {
		// The run keeps going server-side after the socket dies: an in-flight 404
		// first, then the finished result. The turn adopts it with one POST.
		const scenario = dropScenario("resp_resume1", [
			() => new Response("{}", { status: 404 }),
			() => new Response(JSON.stringify(completedResult("resp_resume1")), { status: 200 }),
		]);
		const result = await streamOpenAIResponses(makeModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(scenario.postBodies[0]).toMatchObject({ store: true });
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_resume1");
		expect(scenario.posts).toHaveLength(1);
		expect(scenario.gets).toEqual([
			"https://api.meta.ai/v1/responses/resp_resume1",
			"https://api.meta.ai/v1/responses/resp_resume1",
		]);
		const thinking = result.content.find(block => block.type === "thinking");
		if (!thinking || thinking.type !== "thinking") throw new Error("Expected adopted thinking block");
		expect(thinking.thinking).toContain("full resumed plan");
		const text = result.content.find(block => block.type === "text");
		if (!text || text.type !== "text") throw new Error("Expected adopted text block");
		expect(text.text).toBe("adopted answer");
	});

	it("keeps the socket failure when the stored result is definitively rejected", async () => {
		const scenario = dropScenario("resp_resume2", [() => new Response("gone", { status: 403 })]);
		const result = await streamOpenAIResponses(makeModel("muse-code"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/socket connection was closed/);
		expect(scenario.posts).toHaveLength(1);
		expect(scenario.gets).toHaveLength(1);
		// The dead partial is restored for the caller's retry policy.
		const thinking = result.content.find(block => block.type === "thinking");
		if (!thinking || thinking.type !== "thinking") throw new Error("Expected the dead partial's thinking block");
		expect(thinking.thinking).toBe("partial plan");
	});

	it("never polls for hosts that do not store results", async () => {
		// `store: false` runs are unrecoverable (verified: 404 indefinitely), so a
		// non-storing host must fail fast instead of burning the poll budget.
		const scenario = dropScenario("resp_resume3", [
			() => new Response(JSON.stringify(completedResult("resp_resume3")), { status: 200 }),
		]);
		const result = await streamOpenAIResponses(makeModel("openai"), context, {
			fetch: scenario.fetchImpl,
			apiKey: "test-key",
			providerRetryWait: noWait,
		}).result();

		expect(scenario.postBodies[0]).toMatchObject({ store: false });
		expect(result.stopReason).toBe("error");
		expect(scenario.gets).toEqual([]);
	});
});

describe("pollOpenAIResponsesResultForCompletion", () => {
	const url = "https://api.meta.ai/v1/responses/resp_poll1";
	const headers = { authorization: "Bearer test-key" };

	function sequencedFetch(statuses: Array<{ status: number; body?: unknown }>): {
		fetchImpl: FetchImpl;
		calls: number[];
	} {
		const calls: number[] = [];
		const fetchImpl = (async () => {
			const next = statuses[Math.min(calls.length, statuses.length - 1)];
			calls.push(1);
			if (!next) throw new Error("Expected a scripted poll status");
			return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
		}) as FetchImpl;
		return { fetchImpl, calls };
	}

	it("returns the completed result after in-flight 404s", async () => {
		const { fetchImpl, calls } = sequencedFetch([
			{ status: 404 },
			{ status: 404 },
			{ status: 200, body: completedResult("resp_poll1") },
		]);
		const result = await pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url,
			headers,
			responseId: "resp_poll1",
			wait: noWait,
		});
		expect(result).toMatchObject({ id: "resp_poll1", status: "completed" });
		expect(calls).toHaveLength(3);
	});

	it("adopts an incomplete result that already has output", async () => {
		const incomplete = { ...completedResult("resp_poll1"), status: "incomplete" };
		const { fetchImpl, calls } = sequencedFetch([{ status: 200, body: incomplete }]);
		const result = await pollOpenAIResponsesResultForCompletion({
			fetchImpl,
			url,
			headers,
			responseId: "resp_poll1",
			wait: noWait,
		});
		expect(result).toMatchObject({ status: "incomplete" });
		expect(calls).toHaveLength(1);
	});

	it("gives up at once on failed runs, rejections, and a mismatched id", async () => {
		for (const scripted of [
			{ status: 200, body: { id: "resp_poll1", status: "failed", error: { message: "boom" } } },
			{ status: 403 },
			{ status: 200, body: { id: "resp_other", status: "completed", output: [] } },
		]) {
			const { fetchImpl, calls } = sequencedFetch([scripted]);
			expect(
				await pollOpenAIResponsesResultForCompletion({
					fetchImpl,
					url,
					headers,
					responseId: "resp_poll1",
					wait: noWait,
				}),
			).toBeUndefined();
			expect(calls).toHaveLength(1);
		}
	});

	it("stops after the bounded poll budget when the run never finishes", async () => {
		const { fetchImpl, calls } = sequencedFetch([{ status: 404 }]);
		expect(
			await pollOpenAIResponsesResultForCompletion({
				fetchImpl,
				url,
				headers,
				responseId: "resp_poll1",
				wait: noWait,
			}),
		).toBeUndefined();
		expect(calls).toHaveLength(24);
	});

	it("does not poll once the caller has aborted", async () => {
		const { fetchImpl, calls } = sequencedFetch([{ status: 404 }]);
		const controller = new AbortController();
		controller.abort();
		expect(
			await pollOpenAIResponsesResultForCompletion({
				fetchImpl,
				url,
				headers,
				responseId: "resp_poll1",
				signal: controller.signal,
				wait: noWait,
			}),
		).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});
