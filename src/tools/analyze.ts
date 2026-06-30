/**
 * analyze_module_pool — STEP 1
 *
 * IMPORTANT: This tool does NOT call ADT directly.
 * Source code is fetched by mcp-abap-adt (GetProgram + GetInclude tools)
 * and passed into this tool as input.
 *
 * Workflow:
 *   1. Claude uses mcp-abap-adt GetProgram to get main source
 *   2. Claude uses mcp-abap-adt GetInclude for each include
 *   3. Claude passes combined source to THIS tool for analysis
 *   4. This tool runs Regex + LLM analysis
 */

import { callLLM, parseJSON } from "../llm.js";

interface AnalyzeArgs {
  program_name: string;
  source_code:  string; // combined source from mcp-abap-adt
}

interface LLMAnalysis {
  business_purpose:     string;
  main_entity:          string;
  suggested_rap_entity: string;
  pai_to_rap_mapping:   Array<{ pai_module: string; rap_equivalent: string; notes: string }>;
  pbo_to_rap_mapping:   Array<{ pbo_module: string; rap_equivalent: string; notes: string }>;
  hidden_complexity:    string[];
  migration_risks:      string[];
  suggested_cds_fields: string[];
  complexity_score:     "LOW" | "MEDIUM" | "HIGH";
}

export async function analyzeModulePool(_adt: any, args: AnalyzeArgs) {
  const programName = args.program_name.toUpperCase();
  const src         = args.source_code;

  if (!src || src.trim().length < 10) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        error: "source_code is empty or too short",
        "🔧 HOW TO USE": {
          step1: "Use mcp-abap-adt GetProgram to read: " + programName,
          step2: "Use mcp-abap-adt GetInclude for each include found",
          step3: "Combine all sources and pass as source_code to this tool",
        },
      }, null, 2) }],
      isError: true,
    };
  }

  // ── Step 1: Regex extraction (fast, zero token cost) ─────────────────────
  const facts = extractFacts(src);

  // ── Step 2: LLM deep analysis ─────────────────────────────────────────────
  const condensed  = condenseForLLM(src, facts);
  const llmResult  = await runLLMAnalysis(programName, condensed, facts);

  const output = {
    "🔍 WHAT I GOT": {
      program:      programName,
      total_lines:  src.split("\n").length,
      source_from:  "mcp-abap-adt (GetProgram + GetInclude)",
      tokens_used:  llmResult.tokens,
    },
    "📊 MY ANALYSIS": {
      screens_found:     facts.screens,
      tables_used:       facts.tables,
      pai_modules:       facts.paiModules,
      pbo_modules:       facts.pboModules,
      function_calls:    facts.functionCalls.slice(0, 10),
      business_purpose:  llmResult.analysis?.business_purpose,
      main_entity:       llmResult.analysis?.main_entity,
      suggested_entity:  llmResult.analysis?.suggested_rap_entity,
      complexity:        llmResult.analysis?.complexity_score || facts.complexity,
      migration_risks:   llmResult.analysis?.migration_risks,
      hidden_complexity: llmResult.analysis?.hidden_complexity,
      pai_to_rap:        llmResult.analysis?.pai_to_rap_mapping,
    },
    "➡️  NEXT STEP": `Run check_released_cds with tables: ${JSON.stringify(facts.tables)}. Type YES to continue.`,
    analysis_for_next_step: {
      program_name: programName,
      screens: facts.screens.map((s) => ({
        number:      s,
        pbo_modules: facts.pboModules,
        pai_modules: facts.paiModules,
        fields_detected: [],
      })),
      database_tables: facts.tables,
      function_groups: facts.functionCalls.slice(0, 20),
      data_model_hint: {
        likely_main_table:    llmResult.analysis?.main_entity || facts.tables[0] || null,
        key_fields:           facts.keyFields,
        non_key_fields:       [],
        suggested_cds_fields: llmResult.analysis?.suggested_cds_fields || [],
      },
      migration_complexity:   llmResult.analysis?.complexity_score || facts.complexity,
      complexity_reasons: [
        ...(llmResult.analysis?.migration_risks    || []),
        ...(llmResult.analysis?.hidden_complexity  || []),
        ...facts.reasons,
      ],
      pai_to_rap_mapping: llmResult.analysis?.pai_to_rap_mapping || [],
      pbo_to_rap_mapping: llmResult.analysis?.pbo_to_rap_mapping || [],
    },
  };

  return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
}

// ── Regex extraction ──────────────────────────────────────────────────────────

function extractFacts(src: string) {
  const screens      = [...src.matchAll(/CALL\s+SCREEN\s+(\d+)/gi)].map((m) => m[1]);
  const pboModules   = [...src.matchAll(/^MODULE\s+(\w+)\s+OUTPUT/gim)].map((m) => m[1]);
  const paiModules   = [...src.matchAll(/^MODULE\s+(\w+)\s+INPUT/gim)].map((m) => m[1]);
  const tableMatches = [...src.matchAll(/(?:^TABLES\s+(\w+)|SELECT[^.]+FROM\s+(\w+))/gim)]
    .map((m) => (m[1] || m[2])?.toUpperCase())
    .filter((t): t is string => !!t && !["SCREEN","SSCRFIELDS","SYST"].includes(t));
  const tables        = [...new Set(tableMatches)];
  const functionCalls = [...src.matchAll(/CALL\s+FUNCTION\s+'(\w+)'/gi)].map((m) => m[1]);
  const keyFields     = [...src.matchAll(/\bKEY\b.*?\b(\w{3,})\b/gi)].map((m) => m[1]);

  const reasons: string[] = [];
  if (pboModules.length > 10)          reasons.push(`${pboModules.length} PBO modules`);
  if (functionCalls.length > 5)        reasons.push(`${functionCalls.length} CALL FUNCTIONs`);
  if (src.includes("CALL TRANSACTION")) reasons.push("CALL TRANSACTION found");
  if (src.includes("AUTHORITY-CHECK"))  reasons.push("AUTHORITY-CHECK found");
  if (src.includes("CALL SCREEN"))      reasons.push("Dynamic screen calls found");

  return {
    screens:       [...new Set(screens)],
    pboModules:    [...new Set(pboModules)],
    paiModules:    [...new Set(paiModules)],
    tables:        tables.slice(0, 20),
    functionCalls: [...new Set(functionCalls)],
    keyFields:     keyFields.slice(0, 5),
    complexity:    (reasons.length === 0 ? "LOW" : reasons.length <= 3 ? "MEDIUM" : "HIGH") as "LOW"|"MEDIUM"|"HIGH",
    reasons,
  };
}

function condenseForLLM(src: string, facts: ReturnType<typeof extractFacts>): string {
  const lines = src.split("\n");
  const relevant: string[] = [];
  for (const line of lines) {
    const l = line.trim().toUpperCase();
    if (
      l.startsWith("MODULE")      || l.startsWith("ENDMODULE") ||
      l.startsWith("FORM ")       || l.startsWith("ENDFORM")   ||
      l.startsWith("SELECT")      || l.startsWith("CALL FUNCTION") ||
      l.startsWith("CALL TRANSACTION") || l.startsWith("AUTHORITY-CHECK") ||
      l.startsWith("CASE ")       || l.startsWith("WHEN ")     ||
      l.startsWith("MESSAGE")     || l.startsWith("TABLES")
    ) {
      relevant.push(line);
    }
  }
  return relevant.slice(0, 200).join("\n");
}

async function runLLMAnalysis(
  programName: string,
  condensedCode: string,
  facts: ReturnType<typeof extractFacts>
): Promise<{ analysis: LLMAnalysis | null; tokens: number }> {

  const prompt = `Analyze this SAP Module Pool program for RAP migration.

Program: ${programName}
Tables used: ${facts.tables.join(", ")}
PAI modules: ${facts.paiModules.join(", ")}
PBO modules: ${facts.pboModules.join(", ")}
Screens: ${facts.screens.join(", ")}

Key ABAP statements (condensed):
\`\`\`abap
${condensedCode}
\`\`\`

Return ONLY valid JSON (no markdown):
{
  "business_purpose": "what this program does in 1 sentence",
  "main_entity": "main SAP table e.g. VBAK",
  "suggested_rap_entity": "RAP entity name e.g. SalesOrder",
  "pai_to_rap_mapping": [
    { "pai_module": "USER_COMMAND_0100", "rap_equivalent": "RAP Action: execute_search", "notes": "EXECUTE button" }
  ],
  "pbo_to_rap_mapping": [
    { "pbo_module": "STATUS_0100", "rap_equivalent": "Feature control", "notes": "sets GUI status" }
  ],
  "hidden_complexity": ["complex patterns regex cannot detect"],
  "migration_risks": ["things needing manual review"],
  "suggested_cds_fields": ["field names for CDS view"],
  "complexity_score": "LOW|MEDIUM|HIGH"
}`;

  try {
    const result   = await callLLM(prompt);
    const analysis = parseJSON<LLMAnalysis>(result.text);
    return { analysis, tokens: result.tokens_used };
  } catch (e) {
    console.error("[analyze] LLM failed:", e);
    return { analysis: null, tokens: 0 };
  }
}