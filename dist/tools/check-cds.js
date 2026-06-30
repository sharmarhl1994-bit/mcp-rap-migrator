import { callLLM, parseJSON } from "../llm.js";
function toTableArray(raw) {
    if (!raw)
        return [];
    if (Array.isArray(raw))
        return raw.map(String).map(s => s.trim().toUpperCase()).filter(Boolean);
    if (typeof raw === "string")
        return raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (typeof raw === "object") {
        if (raw.tables)
            return toTableArray(raw.tables);
        return Object.values(raw).flatMap((v) => toTableArray(v));
    }
    return [];
}
export async function checkReleasedCds(_adt, args) {
    const tables = toTableArray(args?.tables ?? args);
    if (tables.length === 0)
        return { content: [{ type: "text", text: JSON.stringify({ error: "No tables" }) }], isError: true };
    const prompt = `You are SAP Clean Core expert. For each table find best released CDS view.
Tables: ${tables.join(", ")}
VBAK->I_SalesOrder, VBAP->I_SalesOrderItem, KONV->I_PricingCondition
EKKO->I_PurchaseOrder, MARA->I_Product, KNA1->I_Customer, LFA1->I_Supplier
Z* tables: use_raw_table true
Return ONLY JSON array no markdown:
[{"table":"VBAK","recommended":"I_SalesOrder","release_state":"C1","confidence":"HIGH","reason":"official API","use_raw_table":false}]`;
    let verdicts = [];
    let tokens = 0;
    let llmError = "";
    try {
        const r = await callLLM(prompt);
        tokens = r.tokens_used;
        verdicts = parseJSON(r.text);
        if (!Array.isArray(verdicts))
            verdicts = [verdicts];
    }
    catch (e) {
        llmError = e?.message || String(e);
        verdicts = tables.map(t => ({
            table: t, recommended: t,
            release_state: "UNKNOWN",
            confidence: "LOW",
            reason: `LLM failed: ${llmError}`,
            use_raw_table: true,
        }));
    }
    const mapping = {};
    for (const v of verdicts)
        mapping[v.table] = v.use_raw_table ? v.table : v.recommended;
    for (const t of tables)
        if (!mapping[t])
            mapping[t] = t;
    return { content: [{ type: "text", text: JSON.stringify({
                    "🔍 WHAT I GOT": { tables_checked: tables, tokens_used: tokens, backend: "SAP AI Core" },
                    "📊 MY ANALYSIS": {
                        summary: verdicts.map((v) => v.use_raw_table
                            ? `⚠️ ${v.table} → raw table`
                            : `✅ ${v.table} → ${v.recommended} (${v.release_state}, ${v.confidence})`),
                        clean_core_score: `${verdicts.filter((v) => !v.use_raw_table).length}/${tables.length}`,
                    },
                    "➡️  NEXT STEP": "Pass cds_source_mapping to generate_rap_skeleton. Type YES.",
                    "cds_source_mapping": mapping,
                    "detailed_verdicts": verdicts,
                    "llm_error": llmError || null,
                }, null, 2) }] };
}
