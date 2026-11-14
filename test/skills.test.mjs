import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ContractError, createScheduler } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { createPiEntity } from "@bitagent/core/pi";
import { createTranslator, SubmissionError } from "@bitagent/core/skills";

function fixture() {
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const entity = createPiEntity(models, faux.getModel());
  return { faux, entity, app: createScheduler() };
}

test("the compiled official function validates its signature and stops on a corrected submit", async () => {
  const { faux, entity, app } = fixture();
  const transcript = [];
  const translate = createTranslator(entity, { maxAttempts: 2, onMessage: (message) => transcript.push(message) });
  assert.throws(() => translate(42, "English"), ContractError);
  assert.equal(faux.state.callCount, 0);
  faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context), /English/);
      return fauxAssistantMessage(fauxToolCall("submit", { value: { text: 42 } }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(JSON.stringify(context), /Invalid submission/);
      return fauxAssistantMessage([
        fauxToolCall("submit", { value: { text: "Hello" } }), fauxText("Do not include this final response."),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("unused"),
  ]);
  const task = app.start(function* () {
    const result = yield* translate("你好", "English");
    assert.equal(entity.status, "idle");
    return result;
  });
  assert.deepEqual(await waitForTask(task), { status: "succeeded", value: { text: "Hello" } });
  assert.equal(faux.state.callCount, 2);
  assert.equal(faux.getPendingResponseCount(), 1);
  assert.doesNotMatch(JSON.stringify(transcript), /final response/);
  assert.equal(transcript.at(-1).content.at(-1).name, "submit");
});

test("each official invocation gets its own context and explicit correction limit", async () => {
  const { faux, entity, app } = fixture();
  const options = { maxAttempts: 1 };
  const translate = createTranslator(entity, options);
  options.maxAttempts = 99;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit", { value: { text: 42 } }), { stopReason: "toolUse" }),
    (context) => {
      assert.doesNotMatch(JSON.stringify(context), /first|Invalid submission/);
      return fauxAssistantMessage(fauxToolCall("submit", { value: { text: "Bonjour" } }), { stopReason: "toolUse" });
    },
  ]);
  const failed = await waitForTask(app.start(() => translate("first", "English")));
  assert.equal(failed.status, "failed");
  assert.ok(failed.error instanceof SubmissionError);
  assert.match(failed.error.message, /after 1 attempts/);
  assert.deepEqual(await waitForTask(app.start(() => translate("second", "French"))), {
    status: "succeeded", value: { text: "Bonjour" },
  });
  assert.equal(faux.state.callCount, 2);
});
