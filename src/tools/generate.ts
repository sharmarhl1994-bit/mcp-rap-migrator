/**
 * generate_rap_skeleton — STEP 2 (INTELLIGENT VERSION)
 *
 * Uses LLM to generate proper ABAP/CDS code based on:
 * - Full analysis from Step 1 (including LLM insights)
 * - CDS source mapping from Step 1b (released views)
 * - PAI/PBO to RAP mapping from LLM analysis
 *
 * NOT template-based — LLM generates context-aware code.
 */

import { callLLM, parseJSON } from "../llm.js";

interface GenerateArgs {
  analysis_json:       string;
  target_package:      string;
  prefix:              string;
  cds_source_mapping?: string;
}

interface GeneratedObject {
  type:   string;
  name:   string;
  source: string;
}

interface LLMGeneratedCode {
  cds_view:             GeneratedObject;
  behavior_definition:  GeneratedObject;
  implementation_class: GeneratedObject;
  metadata_extension:   GeneratedObject;
  generation_notes:     string[];
}

export async function generateRapSkeleton(args: GenerateArgs) {
  let analysis: any;
  let cdsMapping: Record<string, string> = {};

  try {
    const parsed = JSON.parse(args.analysis_json);
    analysis     = parsed.analysis_for_next_step || parsed;
  } catch {
    return { content: [{ type: "text", text: "ERROR: analysis_json is not valid JSON" }], isError: true };
  }

  if (args.cds_source_mapping) {
    try { cdsMapping = JSON.parse(args.cds_source_mapping); } catch {}
  }

  const mainTable  = analysis.data_model_hint?.likely_main_table || "ZTABLE";
  const mainSource = cdsMapping[mainTable] || mainTable;
  const isReleased = mainSource !== mainTable;
  const pkg        = args.target_package.toUpperCase();
  const prefix     = args.prefix.toUpperCase();
  const entityBase = (analysis.data_model_hint?.suggested_cds_fields?.length > 0
    ? analysis.suggested_rap_entity
    : mainTable) || mainTable;
  const entityName = `${prefix}${entityBase.replace(/^Z/, "")}`.toUpperCase();

  // ── LLM generates all 4 ABAP objects ─────────────────────────────────────
  const llmResult = await generateWithLLM({
    analysis,
    entityName,
    mainTable,
    mainSource,
    isReleased,
    pkg,
    prefix,
    cdsMapping,
  });

  const sourceMap: Record<string, string> = {};
  for (const t of (analysis.database_tables || [mainTable])) {
    const src = cdsMapping[t];
    sourceMap[t] = src && src !== t ? `→ ${src} ✅ released CDS` : `→ ${t} ⚠️ raw table`;
  }

  const plan = {
    "🔍 WHAT I GOT": {
      entity_name:       entityName,
      main_table:        mainTable,
      cds_source:        mainSource,
      clean_core:        isReleased,
      source_mapping:    sourceMap,
      tokens_used:       llmResult.tokens,
      objects_to_create: llmResult.code
        ? [
            `DDLS: ${llmResult.code.cds_view.name}`,
            `BDEF: ${llmResult.code.behavior_definition.name}`,
            `CLAS: ${llmResult.code.implementation_class.name}`,
            `DDLS: ${llmResult.code.metadata_extension.name}`,
          ]
        : ["LLM generation failed — see error"],
    },
    "📊 MY ANALYSIS": {
      clean_core_compliant: isReleased,
      cds_source_decision:  isReleased
        ? `✅ Using released CDS ${mainSource} (not raw table ${mainTable})`
        : `⚠️  No released CDS for ${mainTable} — raw table used`,
      llm_generation_notes: llmResult.code?.generation_notes || [],
      pai_rap_mapping:       analysis.pai_to_rap_mapping || [],
    },
    "➡️  NEXT STEP": "Review generated code below. Type YES to create transport and write to SAP, MODIFY to change something, ABORT to stop.",
    generated_objects: llmResult.code
      ? {
          cds_view:             llmResult.code.cds_view,
          behavior_definition:  llmResult.code.behavior_definition,
          implementation_class: llmResult.code.implementation_class,
          metadata_extension:   llmResult.code.metadata_extension,
        }
      : { error: llmResult.error },
  };

  return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
}

// ── LLM Code Generation ───────────────────────────────────────────────────────

async function generateWithLLM(ctx: {
  analysis:    any;
  entityName:  string;
  mainTable:   string;
  mainSource:  string;
  isReleased:  boolean;
  pkg:         string;
  prefix:      string;
  cdsMapping:  Record<string, string>;
}): Promise<{ code: LLMGeneratedCode | null; tokens: number; error?: string }> {

  const paiMapping   = ctx.analysis.pai_to_rap_mapping || [];
  const pboMapping   = ctx.analysis.pbo_to_rap_mapping || [];
  const tables       = ctx.analysis.database_tables || [ctx.mainTable];
  const cdsFields    = ctx.analysis.data_model_hint?.suggested_cds_fields || [];
  const businessGoal = ctx.analysis.business_purpose || "display and manage business data";

  const sourceNote = ctx.isReleased
    ? `Use "${ctx.mainSource}" as CDS source (released SAP API) — DO NOT select from raw table ${ctx.mainTable}`
    : `Use raw table "${ctx.mainSource}" — no released CDS found`;

  const prompt = `Generate complete RAP migration artifacts for this SAP Module Pool program.

PROGRAM INFO:
- Business purpose: ${businessGoal}
- Main entity: ${ctx.mainTable} → RAP entity: ${ctx.entityName}
- Package: ${ctx.pkg}
- All tables used: ${tables.join(", ")}

CDS SOURCE RULE (CRITICAL):
${sourceNote}

CDS source mapping for all tables:
${Object.entries(ctx.cdsMapping).map(([t, s]) => `  ${t} → ${s}`).join("\n")}

PAI MODULE → RAP MAPPING:
${paiMapping.map((m: any) => `  ${m.pai_module} → ${m.rap_equivalent} (${m.notes})`).join("\n")}

PBO MODULE → RAP MAPPING:
${pboMapping.map((m: any) => `  ${m.pbo_module} → ${m.rap_equivalent} (${m.notes})`).join("\n")}

SUGGESTED CDS FIELDS: ${cdsFields.join(", ")}

Generate valid ABAP/CDS code for all 4 objects. Return ONLY valid JSON (no markdown):
{
  "cds_view": {
    "type": "DDLS",
    "name": "${ctx.entityName}",
    "source": "full CDS view source code"
  },
  "behavior_definition": {
    "type": "BDEF",
    "name": "${ctx.entityName}",
    "source": "full BDEF source code"
  },
  "implementation_class": {
    "type": "CLAS",
    "name": "ZBP_${ctx.entityName.replace(/^Z[RC]_/, "")}",
    "source": "full ABAP class source with all methods from PAI mapping"
  },
  "metadata_extension": {
    "type": "DDLS",
    "name": "ZC_${ctx.entityName.replace(/^Z[RC]_/, "")}",
    "source": "full metadata extension with UI annotations"
  },
  "generation_notes": ["important things developer should know"]
}`;

  try {
    // Use higher token limit for code generation
    const result = await callLLM(prompt, undefined);
    const code   = parseJSON<LLMGeneratedCode>(result.text);
    return { code, tokens: result.tokens_used };
  } catch (e: any) {
    return { code: null, tokens: 0, error: `LLM generation failed: ${e.message}` };
  }
}