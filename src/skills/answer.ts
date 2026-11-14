import { ContractError } from "../contracts.js";
import type { ContractParser } from "../contracts.js";
import type { Coroutine } from "../coroutine.js";
import { createSubmitTool } from "../functions.js";
import type { LLMEntity, ModelMessage } from "../model.js";

export interface AnswerRequest {
  readonly prompt: string;
  readonly system: string;
  /** Maximum model generations, including the first attempt. */
  readonly maxAttempts: number;
  /** The application may keep a transcript; the entity never owns one. */
  readonly onMessage?: (message: ModelMessage) => void;
}

export class SubmissionError extends Error {
  constructor(message: string, readonly transcript: readonly ModelMessage[]) {
    super(message);
    this.name = "SubmissionError";
  }
}

/** Official policy, built only from the same public primitives available to user suites. */
export function* answer<T>(
  entity: LLMEntity,
  result: ContractParser<T>,
  request: AnswerRequest,
): Coroutine<T> {
  const { prompt, system, maxAttempts, onMessage } = request;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  const submit = createSubmitTool(result);
  const messages: ModelMessage[] = [];
  const record = (message: ModelMessage) => {
    const snapshot = structuredClone(message);
    messages.push(snapshot);
    onMessage?.(structuredClone(snapshot));
  };
  record({ role: "user", content: prompt, timestamp: Date.now() });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let submitted: { value: T } | undefined;
    const feedback: ModelMessage[] = [];
    const response = yield* entity.generate({
      systemPrompt: system,
      messages: structuredClone(messages),
      tools: [{ name: submit.name, description: submit.description, parameters: submit.parameters }],
    }, {
      onToolCall(call) {
        try {
          if (call.name !== submit.name) throw new ContractError(`Tool ${call.name} is not available; use submit`);
          if (call.argumentsError !== undefined) throw new ContractError(call.argumentsError);
          submitted = { value: submit.parse(call.arguments) };
          return "stop";
        } catch (error) {
          if (!(error instanceof ContractError)) throw error;
          feedback.push({
            role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{ type: "text", text: `Invalid submission: ${error.issues}. Correct the value and call submit again.` }],
            isError: true, timestamp: Date.now(),
          });
          return "continue";
        }
      },
    });
    record(response);
    if (submitted !== undefined) return submitted.value;
    if (response.stopReason !== "toolUse" && response.stopReason !== "stop") {
      throw new SubmissionError(response.errorMessage ?? `Generation ended with ${response.stopReason}`, messages);
    }
    if (feedback.length === 0) {
      record({ role: "user", content: "No result was submitted. Call submit with the declared value.", timestamp: Date.now() });
    } else {
      for (const message of feedback) record(message);
    }
  }
  throw new SubmissionError(`No valid submission after ${maxAttempts} attempts`, messages);
}
