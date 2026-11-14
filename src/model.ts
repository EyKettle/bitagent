import type { AssistantMessage, Context, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { Coroutine } from "./coroutine.js";

// Reuse Pi's explicit transcript types, including provider-native continuation data.
// No runtime dependency or implicit conversation is introduced by these aliases.
export type ModelContext = Context;
export type ModelMessage = Message;
export type ModelResponse = AssistantMessage;
export type ModelTool = Tool;
export type ModelToolCall = ToolCall;

export interface GenerationControl {
  /** Called once per complete tool call. Stopping truncates the response at this call. */
  readonly onToolCall?: (call: ModelToolCall) => "stop" | "continue";
}

export interface LLMEntity {
  readonly name: string;
  readonly activeCalls: number;
  readonly status: "idle" | "generating";
  /** One generation with exactly the supplied context; no automatic tool execution. */
  generate(context: ModelContext, control?: GenerationControl): Coroutine<ModelResponse>;
}
