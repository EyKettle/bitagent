import { createTranslator } from "@bitagent/core/skills";
import type { ModelMessage } from "@bitagent/core";

const transcript: ModelMessage[] = [];
const translate = createTranslator(llm, {
  maxAttempts: 2,
  onMessage(message) { transcript.push(message); },
});
let completed = false;
const job = app.start(function* () {
  const result = yield* translate("你好", "English");
  completed = true;
  return result;
});
job.state;
