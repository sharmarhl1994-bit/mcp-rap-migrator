/**
 * aicore-client.ts
 * Copied pattern from working server.js project.
 *
 * .env variables (exact names from your .env):
 *   AI_CORE_AUTH_URL      — full OAuth URL with /oauth/token
 *   AI_CORE_CLIENT_ID     — client id
 *   AI_CORE_CLIENT_SECRET — client secret
 *   ORCHESTRATION_URL     — full deployment URL
 *   AI_CORE_RESOURCE_GROUP— resource group (default: "default")
 */

interface TokenCache {
  value:     string;
  expiresAt: number;
}

let tokenCache: TokenCache = { value: "", expiresAt: 0 };

async function getAiCoreToken(): Promise<string> {
  // Reuse token if still valid (30s buffer)
  if (tokenCache.value && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.value;
  }

  const authUrl      = process.env.AI_CORE_AUTH_URL!;
  const clientId     = process.env.AI_CORE_CLIENT_ID!;
  const clientSecret = process.env.AI_CORE_CLIENT_SECRET!;

  // Exact same pattern as your working server.js
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch(authUrl, {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`AI Core token failed: ${resp.status} ${err}`);
  }

  const data = await resp.json() as any;

  tokenCache = {
    value:     data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };

  return tokenCache.value;
}

export interface AICoreMessage {
  role:    "user" | "assistant" | "system";
  content: string;
}

export interface AICoreResponse {
  text:        string;
  tokens_used: number;
  model:       string;
}

export async function callAICore(
  messages:     AICoreMessage[],
  systemPrompt: string,
  maxTokens:    number = 1000
): Promise<AICoreResponse> {

  const token         = await getAiCoreToken();
  const orchUrl       = process.env.ORCHESTRATION_URL!;
  const resourceGroup = process.env.AI_CORE_RESOURCE_GROUP || "default";

  // Extract system and user messages
  const userMsg = messages.find(m => m.role === "user")?.content || "";

  // Orchestration payload — same pattern as your server.js
  const payload = {
    config: {
      modules: {
        prompt_templating: {
          model: {
            name:   "anthropic--claude-4.5-haiku",
            params: { temperature: 0.1, max_tokens: maxTokens },
          },
          prompt: {
            template: [
              { role: "system", content: systemPrompt },
              { role: "user",   content: "{{?user_text}}" },
            ],
          },
        },
      },
    },
    placeholder_values: { user_text: userMsg },
  };

  const resp = await fetch(`${orchUrl}/v2/completion`, {
    method:  "POST",
    headers: {
      Authorization:       `Bearer ${token}`,
      "AI-Resource-Group": resourceGroup,
      "Content-Type":      "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Orchestration failed: ${resp.status} ${err.slice(0, 300)}`);
  }

  const data        = await resp.json() as any;
  const content     = data.final_result?.choices?.[0]?.message?.content || "";
  const finishReason= data.final_result?.choices?.[0]?.finish_reason;

  if (finishReason === "length") {
    throw new Error(`LLM response truncated (finish_reason=length). Try reducing prompt size.`);
  }

  const promptTokens     = data.final_result?.usage?.prompt_tokens     || 0;
  const completionTokens = data.final_result?.usage?.completion_tokens || 0;

  return {
    text:        content,
    tokens_used: promptTokens + completionTokens,
    model:       "anthropic--claude-sonnet-4-5",
  };
}