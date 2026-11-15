import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createPiEntity } from "@bitagent/core/pi";

/**
 * A local Messages-API fixture, not a real model or credential-discovering client.
 * @param {string} baseUrl
 * @param {Pick<import("@bitagent/core/pi").PiTextOptions, "fetch">} options
 */
export function createMockEntity(baseUrl = "http://127.0.0.1:4318", options = {}) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("The mock example only connects to a loopback HTTP endpoint");
  }
  /** @type {import("@earendil-works/pi-ai").Model<"anthropic-messages">} */
  const model = {
    id: "bitagent-submit", name: "BitAgent local submit fixture", provider: "bitagent-submit",
    api: "anthropic-messages", baseUrl: endpoint.href,
    reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: model.provider,
    baseUrl: model.baseUrl,
    models: [model],
    api: anthropicMessagesApi(),
    auth: { apiKey: {
      name: "Local mock (not a credential)",
      resolve: async () => ({ auth: { apiKey: "mock" } }),
    } },
  }));
  return createPiEntity(models, model, { timeoutMs: 30000, ...options });
}
