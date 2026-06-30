/**
 * write_abap_object — STEP 3
 * Writes ABAP objects to SAP via ADT REST.
 * Tries multiple ADT paths per object type for compatibility.
 */

import type { AdtClient } from "../adt-client.js";

interface WriteArgs {
  object_type: string;
  object_name: string;
  source_code: string;
  package:     string;
  transport:   string;
}

// Multiple ADT paths to try per type — different S/4 versions use different paths
const ENDPOINTS: Record<string, string[]> = {
  DDLS: [
    "ddic/ddl/sources",      // confirmed working path
    "ddic/ddlsources",       // fallback
    "ddl/sources",           // fallback
  ],
  BDEF: [
    "bo/behaviordefinitions",
    "behaviordefinitions",
  ],
  CLAS: [
    "oo/classes",
  ],
  INTF: [
    "oo/interfaces",
  ],
  PROG: [
    "programs/programs",
  ],
  FUGR: [
    "functions/groups",
  ],
};

const CREATE_CT: Record<string, string> = {
  DDLS: "application/vnd.sap.adt.ddic.ddlsource+xml",
  BDEF: "application/vnd.sap.adt.bo.behaviordefinition+xml",
  CLAS: "application/vnd.sap.adt.oo.class+xml",
  INTF: "application/vnd.sap.adt.oo.interface+xml",
  PROG: "application/vnd.sap.adt.programs.program+xml",
};

export async function writeAbapObject(adt: AdtClient, args: WriteArgs) {
  const name = args.object_name.toUpperCase();
  const type = args.object_type.toUpperCase();
  const pkg  = args.package.toUpperCase();
  const tr   = args.transport;

  const endpoints = ENDPOINTS[type];
  if (!endpoints) {
    return {
      content: [{ type: "text", text: `❌ Unknown object type: ${type}. Supported: ${Object.keys(ENDPOINTS).join(", ")}` }],
      isError: true,
    };
  }

  // Try each endpoint path until one works
  let shellEndpoint = "";
  let shellError    = "";

  for (const ep of endpoints) {
    const result = await tryCreateShell(adt, type, name, pkg, tr, ep);
    if (result.ok) {
      shellEndpoint = ep;
      break;
    }
    if (result.status === "already_exists") {
      shellEndpoint = ep;
      break;
    }
    shellError = result.error || "";
  }

  if (!shellEndpoint) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        "❌ SHELL CREATION FAILED": name,
        type,
        tried_endpoints: endpoints.map(e => `/sap/bc/adt/${e}`),
        last_error: shellError,
        "💡 MANUAL FIX": [
          "1. Open Eclipse ADT",
          `2. Right-click package ${pkg} → New → Other ABAP Repository Object`,
          `3. Search for '${type === "DDLS" ? "Data Definition" : type}'`,
          `4. Name: ${name}`,
          "5. Save → come back and retry write_abap_object",
        ],
      }, null, 2) }],
      isError: true,
    };
  }

  // Write source
  try {
    const trParam = tr && tr !== "$TMP" ? `&corrNr=${tr}` : "";
    const putPath = `/sap/bc/adt/${shellEndpoint}/${name.toLowerCase()}/source/main?sap-client=${process.env.SAP_CLIENT || "100"}${trParam}`;
    const putResp = await adt.put(putPath, args.source_code, "text/plain");

    if (putResp.status !== 200 && putResp.status !== 204) {
      return {
        content: [{ type: "text", text: `❌ Source write failed for ${name}: HTTP ${putResp.status}\n${putResp.body.slice(0, 300)}` }],
        isError: true,
      };
    }
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `❌ Write error for ${name}: ${e.message}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        "✅ WRITTEN": name,
        type,
        package: pkg,
        transport: tr,
        endpoint_used: `/sap/bc/adt/${shellEndpoint}`,
        lines_written: args.source_code.split("\n").length,
        next: `Call validate_and_activate for ${name}, or human_checkpoint first.`,
      }, null, 2),
    }],
  };
}

async function tryCreateShell(
  adt:      AdtClient,
  type:     string,
  name:     string,
  pkg:      string,
  tr:       string,
  endpoint: string
): Promise<{ ok: boolean; status: string; error?: string }> {

  // First check if object already exists via GET
  try {
    const checkResp = await adt.get(`/sap/bc/adt/${endpoint}/${name.toLowerCase()}`);
    if (checkResp.status === 200) {
      return { ok: true, status: "already_exists" };
    }
  } catch { /* not found — proceed to create */ }

  const desc    = `RAP migration: ${name}`;
  const trParam = tr && tr !== "$TMP" && tr ? `?corrNr=${tr}` : "";
  const url     = `/sap/bc/adt/${endpoint}${trParam}`;
  const ct      = CREATE_CT[type] || "application/xml";
  const body    = buildShellXml(type, name, pkg, desc);

  try {
    const resp = await adt.post(url, body, ct);
    if (resp.status === 201) return { ok: true,  status: "created" };
    if (resp.status === 409) return { ok: true,  status: "already_exists" };
    if (resp.status === 200) return { ok: true,  status: "created" };
    return { ok: false, status: `http_${resp.status}`, error: `${endpoint} → HTTP ${resp.status}: ${resp.body.slice(0, 150)}` };
  } catch (e: any) {
    return { ok: false, status: "exception", error: `${endpoint} → ${e.message}` };
  }
}

function buildShellXml(type: string, name: string, pkg: string, desc: string): string {
  switch (type) {
    case "DDLS":
      return `<?xml version="1.0" encoding="utf-8"?>
<ddls:dataDefinition
  xmlns:ddls="http://www.sap.com/adt/ddl"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${desc}"
  adtcore:language="EN"
  adtcore:name="${name}"
  adtcore:package="${pkg}">
</ddls:dataDefinition>`;

    case "BDEF":
      return `<?xml version="1.0" encoding="utf-8"?>
<bdef:behaviorDefinition
  xmlns:bdef="http://www.sap.com/adt/bo/behaviordefinitions"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${desc}"
  adtcore:language="EN"
  adtcore:name="${name}"
  adtcore:package="${pkg}">
</bdef:behaviorDefinition>`;

    case "CLAS":
      return `<?xml version="1.0" encoding="utf-8"?>
<class:abapClass
  xmlns:class="http://www.sap.com/adt/oo/classes"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${desc}"
  adtcore:language="EN"
  adtcore:name="${name}"
  adtcore:package="${pkg}"
  class:final="true"
  class:visibility="public">
</class:abapClass>`;

    case "INTF":
      return `<?xml version="1.0" encoding="utf-8"?>
<intf:abapInterface
  xmlns:intf="http://www.sap.com/adt/oo/interfaces"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${desc}"
  adtcore:language="EN"
  adtcore:name="${name}"
  adtcore:package="${pkg}">
</intf:abapInterface>`;

    default:
      return `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReference
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:name="${name}"
  adtcore:package="${pkg}"
  adtcore:description="${desc}"/>`;
  }
}