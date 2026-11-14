export { createPiEntity } from "./pi-entity.js";

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
import type { TextGenerator, TextRequest, TextResult } from "./index.js";

export type PiTextOptions = Pick<
  ModelsSimpleStreamOptions,
  "apiKey" | "fetch" | "headers" | "timeoutMs" | "transport" | "reasoning"
>;

/** Retains the provider result, including error details and provisional text. */
export class PiGenerationError extends Error {
  constructor(readonly response: AssistantMessage) {
    super(response.errorMessage ?? "Unexpected generation stop reason: " + response.stopReason);
    this.name = "PiGenerationError";
  }
}

/** No resource discovery, history, tool execution, continuation, or wrapper retry. */
export function createPiTextGenerator(
  models: Pick<Models, "streamSimple">,
  model: Model<Api>,
  options: PiTextOptions = {},
): TextGenerator {
  return Object.freeze({
    async generate(request: TextRequest): Promise<TextResult> {
      // Snapshot the request before yielding; the caller owns all application state.
      const { prompt, system, maxTokens, temperature, signal, onText } = request;
      signal?.throwIfAborted();
      const controller = new AbortController();
      const requestSignal = signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]);
      const stream = models.streamSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        ...(system === undefined ? {} : { systemPrompt: system }),
      }, {
        ...options,
        signal: requestSignal,
        maxRetries: 0,
        disableContinuation: true,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(temperature === undefined ? {} : { temperature }),
      });
      try {
        for await (const event of stream) {
          if (event.type === "text_delta") await onText?.(event.delta);
        }
      } catch (error) {
        controller.abort(error);
        // Join the request before reporting an observer failure to its supervisor.
        await stream.result();
        throw error;
      }
      const response = await stream.result();
      if (response.stopReason === "aborted") signal?.throwIfAborted();
      if ((response.stopReason !== "stop" && response.stopReason !== "length") ||
          response.content.some((block) => block.type === "toolCall")) {
        throw new PiGenerationError(response);
      }
      return Object.freeze({
        text: response.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
        finishReason: response.stopReason,
      });
    },
  });
}
