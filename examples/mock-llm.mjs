import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createPiTextGenerator } from "@bitagent/core/pi";

/** Explicit local wiring; no credential discovery or real model calls. */
export function createMockLlm(baseUrl = "http://127.0.0.1:4317/v1") {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("The mock example only connects to a loopback HTTP endpoint");
  }
  /** @type {import("@earendil-works/pi-ai").Model<"openai-completions">} */
  const model = {
    id: "bitagent-mock", name: "BitAgent local mock", provider: "bitagent-mock",
    api: "openai-completions", baseUrl: endpoint.href,
    reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: model.provider,
    baseUrl: model.baseUrl,
    models: [model],
    api: openAICompletionsApi(),
    auth: { apiKey: {
      name: "Local mock (not a credential)",
      resolve: async () => ({ auth: { apiKey: "mock" } }),
    } },
  }));
  return createPiTextGenerator(models, model, { timeoutMs: 5000 });
}
