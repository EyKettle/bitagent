import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ContractError, contractParser } from "../src/contracts.js";
import { createScheduler } from "../src/coroutine.js";
import { createSubmitTool } from "../src/functions.js";
import { waitForTask } from "../src/host.js";
import type { ModelMessage } from "../src/model.js";
import { createPiEntity } from "../src/pi-entity.js";
import { answer, SubmissionError } from "../src/skills/answer.js";

interface Translation { text: string; language: "en" | "zh"; }
const translation = contractParser<Translation>({
  type: "object", properties: { text: { type: "string" }, language: { enum: ["en", "zh"] } },
  required: ["text", "language"], additionalProperties: false,
});
const request = { prompt: "translate", system: "Submit the translation.", maxAttempts: 3 };

function fixture() {
  const faux = fauxProvider({ tokensPerSecond: 10000, tokenSize: { min: 2, max: 2 } });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, entity: createPiEntity(models, faux.getModel()), scheduler: createScheduler() };
}

test("submit parsing is strict, isolated from policy, and handles referenced return types", () => {
  const parser = contractParser<{ node: { value: string } }>({
    type: "object", properties: { node: { $ref: "#/definitions/Node" } }, required: ["node"], additionalProperties: false,
    definitions: { Node: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
  });
  const submit = createSubmitTool(parser);
  const input = { value: { node: { value: "ok" } } };
  const value = submit.parse(input);
  input.value.node.value = "changed";
  assert.equal(value.node.value, "ok");
  assert.throws(() => submit.parse({ value: { node: { value: 42 } } }), ContractError);
  assert.throws(() => submit.parse({ value: { node: { value: "ok" } }, extra: true }), ContractError);
  const schema = submit.parameters as Record<string, unknown>;
  schema.type = "number";
  assert.deepEqual(submit.parse({ value: { node: { value: "still valid" } } }), { node: { value: "still valid" } });
});

test("official policy reports an invalid submit, accepts the correction, and stops at the tool call", async () => {
  const { faux, entity, scheduler } = fixture();
  const transcript: ModelMessage[] = [];
  let finalSignal: AbortSignal | undefined;
  faux.setResponses([
    (context, options) => {
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.disableContinuation, true);
      assert.equal(entity.activeCalls, 1);
      assert.equal(entity.status, "generating");
      assert.match(JSON.stringify(context), /submit/);
      return fauxAssistantMessage(fauxToolCall("submit", { value: { text: 42, language: "en" } }), { stopReason: "toolUse" });
    },
    (context, options) => {
      assert.match(JSON.stringify(context.messages), /Invalid submission/);
      assert.match(JSON.stringify(context.messages), /"isError":true/);
      finalSignal = options?.signal;
      return fauxAssistantMessage([
        fauxToolCall("submit", { value: { text: "Hello", language: "en" } }),
        fauxText("This extra response must not reach application history."),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("No final response should be requested."),
  ]);
  const task = scheduler.start(function* () {
    const result = yield* answer(entity, translation, { ...request, onMessage: (message) => { transcript.push(message); } });
    assert.equal(entity.status, "idle");
    assert.equal(entity.activeCalls, 0);
    return result;
  });
  assert.deepEqual(await waitForTask(task), { status: "succeeded", value: { text: "Hello", language: "en" } });
  assert.equal(faux.state.callCount, 2);
  assert.equal(faux.getPendingResponseCount(), 1);
  assert.equal(finalSignal?.aborted, true);
  assert.doesNotMatch(JSON.stringify(transcript), /extra response/);
  assert.equal(transcript.at(-1)?.role, "assistant");
  const last = transcript.at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.content.at(-1)?.type, "toolCall");
});

test("the calling program can parse a valid submit without stopping the entity", async () => {
  const { faux, entity, scheduler } = fixture();
  const submit = createSubmitTool(translation);
  let parsed: Translation | undefined;
  let signal: AbortSignal | undefined;
  faux.setResponses([(_context, options) => {
    signal = options?.signal;
    return fauxAssistantMessage([
      fauxToolCall("submit", { value: { text: "Hello", language: "en" } }), fauxText("program chose to continue"),
    ], { stopReason: "toolUse" });
  }]);
  const task = scheduler.start(function* () {
    return yield* entity.generate({
      messages: [{ role: "system", content: "input", toolsAdded: [submit], timestamp: 0 }],
      tools: [submit],
    }, {
      onToolCall(call) { parsed = submit.parse(call.arguments); return "continue"; },
    });
  });
  const outcome = await waitForTask(task);
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(parsed, { text: "Hello", language: "en" });
  if (outcome.status === "succeeded") assert.match(JSON.stringify(outcome.value), /program chose to continue/);
  assert.equal(signal?.aborted, false);
});

test("correction has a bound and transport failures do not spend it on blind retries", async () => {
  const { faux, entity, scheduler } = fixture();
  faux.setResponses([
    fauxAssistantMessage("forgot the tool"),
    fauxAssistantMessage(fauxToolCall("submit", { value: { text: "x", language: "invalid" } }), { stopReason: "toolUse" }),
    fauxAssistantMessage("unused"),
  ]);
  const limited = await waitForTask(scheduler.start(() => answer(entity, translation, { ...request, maxAttempts: 2 })));
  assert.equal(limited.status, "failed");
  if (limited.status === "failed") {
    assert.ok(limited.error instanceof SubmissionError);
    assert.match(limited.error.message, /after 2 attempts/);
    assert.match(JSON.stringify(limited.error.transcript), /No result was submitted|Invalid submission/);
  }
  assert.equal(faux.state.callCount, 2);
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline" })]);
  const failed = await waitForTask(scheduler.start(() => answer(entity, translation, request)));
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(String(failed.error), /offline/);
  assert.equal(faux.state.callCount, 3);
});

test("contexts are snapshotted and entities do not own history", async () => {
  const { faux, entity, scheduler } = fixture();
  const received: string[] = [];
  faux.setResponses([1, 2].map(() => (context) => { received.push(JSON.stringify(context)); return fauxAssistantMessage("answer"); }));
  const input = { messages: [{ role: "user" as const, content: "first", timestamp: 0 }] };
  const generation = entity.generate(input);
  input.messages[0]!.content = "changed";
  await waitForTask(scheduler.start(() => generation));
  await waitForTask(scheduler.start(() => entity.generate({ messages: [{ role: "user", content: "second", timestamp: 0 }] })));
  assert.match(received[0]!, /first/);
  assert.doesNotMatch(received[0]!, /changed/);
  assert.doesNotMatch(received[1]!, /first|answer/);
});

test("cancelling an entity request waits for settlement and preserves the cancellation reason", async () => {
  const { faux, entity, scheduler } = fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  faux.setResponses([() => {
    started();
    return fauxAssistantMessage("a long enough response to cancel before completion");
  }]);
  const task = scheduler.start(() => entity.generate({ messages: [{ role: "user", content: "cancel", timestamp: 0 }] }));
  await ready;
  const reason = new Error("owner cancelled");
  task.cancel(reason);
  assert.equal(task.state.status, "cancelling");
  assert.deepEqual(await waitForTask(task), { status: "cancelled", reason });
  assert.equal(entity.status, "idle");
  assert.equal(entity.activeCalls, 0);
});
