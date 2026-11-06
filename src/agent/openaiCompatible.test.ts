import { describe, expect, it } from "vitest";
import { OpenAICompatibleBackend } from "./openaiCompatible.js";
import {
  createWebSearchProviders,
  webSearchToolDefinitions,
  type WebSearchProvider,
} from "./tools/webSearch.js";

describe("OpenAICompatibleBackend", () => {
  it("calls chat completions and stores assistant reply", async () => {
    const calls: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello adventurer." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const backend = new OpenAICompatibleBackend({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      temperature: 0.2,
      maxTokens: 64,
      memoryMaxMessages: 10,
      fetchImpl,
    });

    const res = await backend.generate({
      conversationKey: "chan",
      authorDisplayName: "Nate",
      content: "hi",
    });
    expect(res.text).toBe("Hello adventurer.");
    expect(calls).toHaveLength(1);
  });

  it("forces a final reply after max tool rounds", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
      if (calls <= 3) {
        expect(body.tools).toBeDefined();
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: `call_${calls}`,
                      type: "function",
                      function: { name: "web_search", arguments: "{\"query\":\"7dtd water\"}" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      expect(body.tools).toBeUndefined();
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Collect murky water then boil it." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const backend = new OpenAICompatibleBackend({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      temperature: 0.2,
      maxTokens: 64,
      memoryMaxMessages: 10,
      braveApiKey: "brave",
      webSearchProviders: [
        {
          name: "test",
          search: async () => [],
        },
      ],
      fetchImpl,
      maxToolRounds: 3,
    });

    const res = await backend.generate({
      conversationKey: "chan",
      authorDisplayName: "Nate",
      content: "how do I get water?",
    });
    expect(res.text).toBe("Collect murky water then boil it.");
    expect(calls).toBe(4);
  });

  it("bounds web_search calls per round and per request with tool-result errors", async () => {
    let providerCalls = 0;
    const provider: WebSearchProvider = {
      name: "test",
      search: async (query) => {
        providerCalls += 1;
        return [{ title: query, url: "https://example.com", snippet: "result" }];
      },
    };
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let completionCall = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      completionCall += 1;
      requests.push(JSON.parse(String(init?.body)));
      if (completionCall <= 2) {
        const count = completionCall === 1 ? 3 : 2;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: Array.from({ length: count }, (_, index) => ({
                    id: `call_${completionCall}_${index}`,
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: JSON.stringify({ query: `query ${completionCall}-${index}` }),
                    },
                  })),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "bounded" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const backend = new OpenAICompatibleBackend({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      temperature: 0.2,
      maxTokens: 64,
      memoryMaxMessages: 10,
      webSearchProviders: [provider],
      fetchImpl,
      maxWebSearchCallsPerRound: 2,
      maxWebSearchCallsPerRequest: 3,
    });

    await expect(
      backend.generate({ conversationKey: "chan", authorDisplayName: "Nate", content: "search" }),
    ).resolves.toEqual({ text: "bounded" });
    expect(providerCalls).toBe(3);

    const toolResults = requests[2]!.messages
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(message.content) as { error?: string });
    expect(toolResults).toContainEqual({
      error: "web_search call budget exceeded for this round",
    });
    expect(toolResults).toContainEqual({
      error: "web_search call budget exceeded for this request",
    });
  });

  it("includes channel context in the user message", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Check houses and traders." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const backend = new OpenAICompatibleBackend({
      apiBaseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      temperature: 0.2,
      maxTokens: 64,
      memoryMaxMessages: 10,
      fetchImpl,
    });

    await backend.generate({
      conversationKey: "thread:t1",
      authorDisplayName: "Nate",
      content: "where are cooking pots?",
      channelName: "7dtd",
      threadName: "water tips",
      channelTopic: "7 Days to Die",
      guildName: "Farmers",
    });

    const userMsg = calls[0]!.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("#7dtd");
    expect(userMsg?.content).toContain("thread: water tips");
    expect(userMsg?.content).toContain("topic: 7 Days to Die");
    expect(userMsg?.content).toContain("where are cooking pots?");
  });

});


describe("web search tools", () => {
  it("exposes no tools when keys are unset", () => {
    const providers = createWebSearchProviders({});
    expect(providers).toEqual([]);
    expect(webSearchToolDefinitions(providers)).toEqual([]);
  });

  it("exposes web_search when a key is set", () => {
    const providers = createWebSearchProviders({ braveApiKey: "b" });
    expect(providers).toHaveLength(1);
    expect(webSearchToolDefinitions(providers)).toHaveLength(1);
  });
});
