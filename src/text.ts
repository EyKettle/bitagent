/** All model-visible text is supplied by the caller on each request. */
export interface TextRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** Provisional text: a stream may subsequently fail or be truncated. */
  readonly onText?: (delta: string) => void | Promise<void>;
}

export interface TextResult {
  readonly text: string;
  readonly finishReason: "stop" | "length";
}

export interface TextGenerator {
  generate(request: TextRequest): Promise<TextResult>;
}
