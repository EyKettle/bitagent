import { defineFunction } from "@bitagent/core";
import { answer } from "@bitagent/core/skills";

type Classify = (text: string) => { label: string; items: number };
const classify = defineFunction<Classify>(function* (result, text) {
  return yield* answer(llm, result, {
    system: "Use submit to return the declared result.",
    prompt: "[user-function] " + text,
    maxAttempts: 2,
  });
});
const customJob = app.start(function* () {
  const result = yield* classify("a small example");
  return result.label + ":" + result.items;
});
customJob.state;
