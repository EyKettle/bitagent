export { createTranslator } from "./translate.js";
export type { Translate, Translation, TranslatorOptions } from "./translate.js";
export { answer, SubmissionError } from "./answer.js";
export type { AnswerRequest } from "./answer.js";

import type { TextGenerator, TextResult } from "../index.js";

export interface SummarizeInput {
  readonly text: string;
  readonly instruction: string;
}

/** An ordinary function: no registration, agent, hidden history, or special host access. */
export function summarize(
  llm: TextGenerator,
  input: SummarizeInput,
  signal?: AbortSignal,
): Promise<TextResult> {
  return llm.generate({
    system: input.instruction,
    prompt: input.text,
    ...(signal === undefined ? {} : { signal }),
  });
}
