/**
 * llm.ts — SAP AI Core only (no Anthropic fallback)
 */

import { callAICore } from "./aicore-client.js";

export const SAP_EXPERT_SYSTEM = `You are an SAP ABAP expert with 15+ years experience in:
- S/4HANA, BTP ABAP Cloud, RAP (RESTful ABAP Programming Model)
- CDS Views, Behavior Definitions, OData V4
- Clean Core principles — never SELECT from raw tables if released CDS exists
- Module Pool to RAP migration patterns

Rules:
- Always prefer released SAP CDS APIs (I_ prefix, C1 release state)
- Never recommend deprecated (P_, X_ prefix) or internal views
- Return JSON only unless told otherwise — no markdown fences
- Never hallucinate SAP object names — if unsure say confidence: LOW`;

export interface LLMResponse {
  text:        string;
  tokens_used: number;
  backend:     "aicore";
}

export async function callLLM(
  userPrompt:      string,
  systemOverride?: string,
  maxTokens:       number = 8000  // increased for code generation
): Promise<LLMResponse> {

  const system = systemOverride || SAP_EXPERT_SYSTEM;

  // Log what we're about to do
  console.error(`[llm] Calling AI Core... ORCH=${process.env.ORCHESTRATION_URL?.slice(0,50)}`);

  const result = await callAICore(
    [{ role: "user", content: userPrompt }],
    system,
    maxTokens
  );

  console.error(`[llm] AI Core success — tokens: ${result.tokens_used}`);

  return {
    text:        result.text,
    tokens_used: result.tokens_used,
    backend:     "aicore",
  };
}

export function parseJSON<T>(text: string): T {
  const clean = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  return JSON.parse(clean) as T;
}