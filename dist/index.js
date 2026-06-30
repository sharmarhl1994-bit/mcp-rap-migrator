import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { AdtClient } from "./adt-client.js";
import { analyzeModulePool } from "./tools/analyze.js";
import { generateRapSkeleton } from "./tools/generate.js";
import { writeAbapObject } from "./tools/write.js";
import { validateAndActivate } from "./tools/activate.js";
import { createTransport } from "./tools/transport.js";
import { humanCheckpoint } from "./tools/checkpoint.js";
import { checkReleasedCds } from "./tools/check-cds.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
// ── Config ──────────────────────────────────────────────────────────────────
const SAP_URL = process.env.SAP_URL;
const SAP_USER = process.env.SAP_USERNAME;
const SAP_PASS = process.env.SAP_PASSWORD;
const SAP_CLIENT = process.env.SAP_CLIENT || "100";
if (!SAP_URL || !SAP_USER || !SAP_PASS) {
    throw new Error("SAP_URL, SAP_USERNAME, SAP_PASSWORD must be set in .env");
}
// ── ADT client (shared, keeps CSRF token alive) ──────────────────────────────
export const adt = new AdtClient({ url: SAP_URL, user: SAP_USER, pass: SAP_PASS, client: SAP_CLIENT });
// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server({ name: "mcp-rap-migrator", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "analyze_module_pool",
            description: "STEP 1 — Analyzes Module Pool source code fetched by mcp-abap-adt. IMPORTANT: First use mcp-abap-adt GetProgram to get program source, then GetInclude for each include, then pass combined source here. Returns structured JSON: screens, PAI/PBO modules, tables, LLM business analysis, PAI-to-RAP mapping.",
            inputSchema: {
                type: "object",
                properties: {
                    program_name: { type: "string", description: "SAP Module Pool program name e.g. ZSALES_ORDER_VIEWER" },
                    source_code: { type: "string", description: "Combined ABAP source from mcp-abap-adt GetProgram + GetInclude calls" },
                },
                required: ["program_name", "source_code"],
            },
        },
        {
            name: "check_released_cds",
            description: "STEP 1b — MANDATORY before generate_rap_skeleton. Checks if SAP has released CDS views for the tables found in the Module Pool. Clean Core: always SELECT from released CDS instead of raw tables. Returns cds_source_mapping to pass into generate_rap_skeleton.",
            inputSchema: { type: "object", properties: { tables: { type: "array", items: { type: "string" }, description: "Tables from analyze_module_pool e.g. VBAK,VBAP,KONV" } }, required: ["tables"] },
        },
        {
            name: "generate_rap_skeleton",
            description: "STEP 2 — Given the analysis JSON from step 1, generates the full RAP migration plan: CDS view, Behavior Definition, Behavior Implementation class, metadata extensions. Returns ABAP code as strings — does NOT write to SAP yet. Human must approve.",
            inputSchema: {
                type: "object",
                properties: {
                    analysis_json: { type: "string", description: "JSON string from analyze_module_pool" },
                    target_package: { type: "string", description: "SAP package for new objects e.g. ZMIGRATED" },
                    prefix: { type: "string", description: "Z-prefix for generated objects e.g. ZR_" },
                },
                required: ["analysis_json", "target_package", "prefix"],
            },
        },
        {
            name: "human_checkpoint",
            description: "MANDATORY between every step — shows the human: WHAT WAS DONE, ANALYSIS SUMMARY, and NEXT PROPOSED ACTION. Human must type YES/MODIFY/ABORT to proceed. Always call this before write_abap_object or validate_and_activate.",
            inputSchema: {
                type: "object",
                properties: {
                    step_title: { type: "string" },
                    what_i_got: { type: "string", description: "Summary of data retrieved/generated" },
                    my_analysis: { type: "string", description: "Agent interpretation and migration decisions" },
                    next_action: { type: "string", description: "What agent will do next if approved" },
                    code_preview: { type: "string", description: "Optional: ABAP code snippet to show human (first 50 lines)" },
                },
                required: ["step_title", "what_i_got", "my_analysis", "next_action"],
            },
        },
        {
            name: "write_abap_object",
            description: "STEP 3 — Writes a single ABAP object to SAP via ADT REST. CRITICAL: Always follow this exact order: 1st=CDS Root View (DDLS), 2nd=CDS Child Views (DDLS), 3rd=Behavior Definition (BDEF), 4th=Implementation Class (CLAS), 5th=Metadata Extension (DDLS). NEVER write BDEF before CDS views. NEVER write CLAS before BDEF. One object at a time only.",
            inputSchema: {
                type: "object",
                properties: {
                    object_type: { type: "string", enum: ["CLAS", "DDLS", "BDEF", "INTF", "FUGR", "PROG"], description: "ABAP object type" },
                    object_name: { type: "string", description: "Object name in SAP" },
                    source_code: { type: "string", description: "Full ABAP/CDS source to write" },
                    package: { type: "string" },
                    transport: { type: "string", description: "Transport request number" },
                },
                required: ["object_type", "object_name", "source_code", "package", "transport"],
            },
        },
        {
            name: "validate_and_activate",
            description: "STEP 4 — Activates one or more ABAP objects via ADT REST. Runs syntax check first, returns errors for agent to fix before activation. Call human_checkpoint with results.",
            inputSchema: {
                type: "object",
                properties: {
                    objects: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                type: { type: "string" },
                                name: { type: "string" },
                            },
                            required: ["type", "name"],
                        },
                        description: "List of {type, name} to activate in order",
                    },
                },
                required: ["objects"],
            },
        },
        {
            name: "create_transport",
            description: "Creates a Workbench Transport Request in SAP. Do this before write_abap_object. Returns transport number.",
            inputSchema: {
                type: "object",
                properties: {
                    description: { type: "string", description: "Transport description e.g. 'RAP Migration of SAPMZ_DEMO'" },
                    target_system: { type: "string", description: "Target system SID e.g. Q01" },
                },
                required: ["description"],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
        switch (name) {
            case "analyze_module_pool": return await analyzeModulePool(adt, args);
            case "check_released_cds": return await checkReleasedCds(adt, args);
            case "generate_rap_skeleton": return await generateRapSkeleton(args);
            case "human_checkpoint": return await humanCheckpoint(args);
            case "write_abap_object": return await writeAbapObject(adt, args);
            case "validate_and_activate": return await validateAndActivate(adt, args);
            case "create_transport": return await createTransport(adt, args);
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    }
    catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
});
// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp-rap-migrator] Server started");
