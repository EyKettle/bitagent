import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { fromAsync } from "./host.js";
import type { Coroutine } from "./coroutine.js";
import type { GenerationControl, LLMEntity, ModelContext, ModelResponse, ModelTool } from "./model.js";
import type { PiTextOptions } from "./pi.js";

/** Only declaration data crosses into a request; local tool methods stay local. */
function snapshotContext(context: ModelContext): ModelContext {
  const declaration = ({ name, description, parameters, constrainedSampling }: ModelTool): ModelTool => ({
    name, description, parameters,
    ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
  });
  return structuredClone({
    ...context,
    ...(context.tools === undefined ? {} : { tools: context.tools.map(declaration) }),
    messages: context.messages.map((message) => message.role === "system" && message.toolsAdded !== undefined
      ? { ...message, toolsAdded: message.toolsAdded.map(declaration) }
      : message),
  });
}

/** A stateless generator. Context and decisions belong to the calling program. */
export function createPiEntity(
  models: Pick<Models, "streamSimple">,
  model: Model<Api>,
  options: PiTextOptions = {},
): LLMEntity {
  const settings = { ...options, ...(options.headers === undefined ? {} : { headers: { ...options.headers } }) };
  let activeCalls = 0;
  return Object.freeze({
    name: model.name,
    get activeCalls() { return activeCalls; },
    get status() { return activeCalls === 0 ? "idle" as const : "generating" as const; },
    generate(context: ModelContext, control: GenerationControl = {}): Coroutine<ModelResponse> {
      const snapshot = snapshotContext(context);
      const onToolCall = control.onToolCall;
      return fromAsync(async (signal) => {
        signal.throwIfAborted();
        activeCalls++;
        try {
          const stop = new AbortController();
          const stream = models.streamSimple(model, snapshot, {
            ...settings, signal: AbortSignal.any([signal, stop.signal]),
            maxRetries: 0, disableContinuation: true,
          });
          let accepted: ModelResponse | undefined;
          try {
            for await (const event of stream) {
              signal.throwIfAborted();
              if (event.type !== "toolcall_end") continue;
              if (onToolCall?.(structuredClone(event.toolCall)) === "stop") {
                accepted = structuredClone({
                  ...event.partial,
                  content: event.partial.content.slice(0, event.contentIndex + 1),
                  stopReason: "toolUse",
                });
                stop.abort();
                break;
              }
            }
          } catch (error) {
            stop.abort(error);
            await stream.result();
            throw error;
          }
          // A stop/cancel is settled before the caller receives a completion value.
          const response = await stream.result();
          signal.throwIfAborted();
          return accepted ?? response;
        } finally {
          activeCalls--;
        }
      });
    },
  });
}
