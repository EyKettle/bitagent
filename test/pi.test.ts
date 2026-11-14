import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiTextGenerator, PiGenerationError } from "../src/pi.js";

function fixture() {
  const faux = fauxProvider({ tokensPerSecond: 10000, tokenSize: { min: 2, max: 2 } });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, llm: createPiTextGenerator(models, faux.getModel()) };
}

test("each generation receives only explicit input and never accumulates history", async () => {
  const { faux, llm } = fixture();
  const received: string[] = [];
  faux.setResponses([1, 2].map(() => (context, options) => {
    received.push(JSON.stringify(context.messages));
    assert.equal(options?.maxRetries, 0);
    assert.equal(options?.disableContinuation, true);
    return fauxAssistantMessage("answer");
  }));
  const request = { prompt: "first input", system: "first instruction" };
  const pending = llm.generate(request);
  request.prompt = "mutated input";
  await pending;
  await llm.generate({ prompt: "second input" });
  assert.match(received[0]!, /first input/);
  assert.match(received[0]!, /first instruction/);
  assert.doesNotMatch(received[0]!, /mutated input/);
  assert.match(received[1]!, /second input/);
  assert.doesNotMatch(received[1]!, /first input|first instruction|answer/);
  assert.equal(faux.state.callCount, 2);
});

test("streamed text and truncation are returned without an automatic continuation", async () => {
  const { faux, llm } = fixture();
  faux.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);
  const chunks: string[] = [];
  const result = await llm.generate({ prompt: "input", onText: async (delta) => { chunks.push(delta); } });
  assert.deepEqual(result, { text: "partial answer", finishReason: "length" });
  assert.equal(chunks.join(""), result.text);
  assert.equal(faux.state.callCount, 1);
});

test("provider errors and unexpected tool requests fail without a tool loop", async () => {
  const { faux, llm } = fixture();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream failure" }),
    fauxAssistantMessage(fauxToolCall("write", { path: "not-executed" }), { stopReason: "toolUse" }),
  ]);
  await assert.rejects(llm.generate({ prompt: "fail" }), /upstream failure/);
  await assert.rejects(llm.generate({ prompt: "tool" }), (error: unknown) =>
    error instanceof PiGenerationError && error.response.stopReason === "toolUse");
  assert.equal(faux.state.callCount, 2);
});

test("pre-aborted requests never reach the provider", async () => {
  const { faux, llm } = fixture();
  const reason = new Error("cancel before submit");
  await assert.rejects(llm.generate({ prompt: "input", signal: AbortSignal.abort(reason) }), (error) => error === reason);
  assert.equal(faux.state.callCount, 0);
});

test("in-flight cancellation preserves the caller's reason", async () => {
  const { faux, llm } = fixture();
  faux.setResponses([fauxAssistantMessage("a long enough answer to cancel while streaming")]);
  const controller = new AbortController();
  const reason = new Error("cancel during stream");
  await assert.rejects(llm.generate({
    prompt: "input",
    signal: controller.signal,
    onText: () => { controller.abort(reason); },
  }), (error) => error === reason);
});

test("a failing observer aborts and joins the underlying request", async () => {
  const { faux, llm } = fixture();
  let requestSignal: AbortSignal | undefined;
  faux.setResponses([(_context, options) => {
    requestSignal = options?.signal;
    return fauxAssistantMessage("a long answer for observer cancellation");
  }]);
  const failure = new Error("observer failed");
  await assert.rejects(llm.generate({ prompt: "input", onText: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(requestSignal?.aborted, true);
});
