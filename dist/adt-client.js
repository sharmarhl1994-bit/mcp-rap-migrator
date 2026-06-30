/**
 * AdtClient — thin wrapper around the ADT REST API.
 * Keeps one authenticated session, handles CSRF tokens transparently.
 * Token-efficient: reuses session cookies, only re-fetches CSRF on 403.
 */
import https from "https";
export class AdtClient {
    config;
    csrfToken = null;
    sessionCookie = null;
    agent;
    constructor(config) {
        this.config = config;
        this.agent = new https.Agent({
            rejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== "false",
            keepAlive: true, // reuse TCP connections
        });
    }
    get baseHeaders() {
        const auth = Buffer.from(`${this.config.user}:${this.config.pass}`).toString("base64");
        const h = {
            Authorization: `Basic ${auth}`,
            "sap-client": this.config.client,
            Accept: "application/xml, text/plain, */*",
        };
        if (this.sessionCookie)
            h["Cookie"] = this.sessionCookie;
        return h;
    }
    /** Fetch CSRF token (called automatically on first mutating request) */
    async fetchCsrf() {
        const resp = await this.request("GET", "/sap/bc/adt/discovery", {
            "X-CSRF-Token": "Fetch",
        });
        this.csrfToken = resp.headers["x-csrf-token"] || null;
        const cookies = resp.headers["set-cookie"];
        if (cookies) {
            this.sessionCookie = Array.isArray(cookies) ? cookies.join("; ") : cookies;
        }
    }
    /** Raw HTTP request — low-level, all other methods call this */
    async request(method, path, extraHeaders = {}, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.config.url + path);
            const options = {
                method,
                hostname: url.hostname,
                port: url.port ? parseInt(url.port) : (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search,
                headers: { ...this.baseHeaders, ...extraHeaders },
                agent: this.agent,
            };
            if (body) {
                options.headers["Content-Length"] = Buffer.byteLength(body);
            }
            const req = https.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode || 0,
                        body: data,
                        headers: res.headers,
                    });
                });
            });
            req.on("error", reject);
            if (body)
                req.write(body);
            req.end();
        });
    }
    /** GET with session reuse */
    async get(path, accept = "text/plain") {
        return this.request("GET", path, { Accept: accept });
    }
    /** PUT — auto-fetches CSRF, retries once on 403 */
    async put(path, body, contentType = "text/plain") {
        if (!this.csrfToken)
            await this.fetchCsrf();
        const headers = {
            "X-CSRF-Token": this.csrfToken,
            "Content-Type": contentType,
        };
        let resp = await this.request("PUT", path, headers, body);
        if (resp.status === 403) {
            // Token expired — refresh once
            await this.fetchCsrf();
            headers["X-CSRF-Token"] = this.csrfToken;
            resp = await this.request("PUT", path, headers, body);
        }
        return resp;
    }
    /** POST — auto-fetches CSRF */
    async post(path, body, contentType = "application/xml") {
        if (!this.csrfToken)
            await this.fetchCsrf();
        const headers = {
            "X-CSRF-Token": this.csrfToken,
            "Content-Type": contentType,
        };
        let resp = await this.request("POST", path, headers, body);
        if (resp.status === 403) {
            await this.fetchCsrf();
            headers["X-CSRF-Token"] = this.csrfToken;
            resp = await this.request("POST", path, headers, body);
        }
        return resp;
    }
    /** Convenience: get ABAP program source
     *  Tries multiple ADT paths:
     *  - /programs/programs/{name}/source/main  — standard + module pool
     *  - /programs/includes/{name}/source/main  — include programs
     *  Module pools (SAPMZ_*) use the programs/programs path in ADT.
     */
    async getProgramSource(programName) {
        const name = programName.toLowerCase();
        // ADT paths to try in order
        const paths = [
            `/sap/bc/adt/programs/programs/${name}/source/main`,
            `/sap/bc/adt/programs/includes/${name}/source/main`,
        ];
        let lastError = "";
        for (const path of paths) {
            try {
                const resp = await this.get(path);
                if (resp.status === 200)
                    return resp.body;
                lastError = `HTTP ${resp.status}: ${resp.body.slice(0, 150)}`;
            }
            catch (e) {
                lastError = e.message;
            }
        }
        // Try ADT object search to give better error hint
        let hint = "";
        try {
            const searchResp = await this.get(`/sap/bc/adt/repository/informationsystem/search?operation=quickSearch&query=${name.toUpperCase()}&maxResults=3`, "application/xml");
            hint = searchResp.body.includes(name.toUpperCase())
                ? " Object found in repo — check object type or SICF service activation."
                : " Object not found in repo — verify program name in SE38.";
        }
        catch {
            hint = "";
        }
        throw new Error(`Cannot read "${programName}": ${lastError}.${hint}`);
    }
    /** Convenience: get include source */
    async getIncludeSource(includeName) {
        const path = `/sap/bc/adt/programs/includes/${includeName.toLowerCase()}/source/main`;
        const resp = await this.get(path);
        if (resp.status !== 200)
            throw new Error(`ADT GET include failed: ${resp.status}`);
        return resp.body;
    }
    /** Convenience: get class source */
    async getClassSource(className, section = "main") {
        const path = `/sap/bc/adt/oo/classes/${className.toLowerCase()}/source/${section}`;
        const resp = await this.get(path);
        if (resp.status !== 200)
            throw new Error(`ADT GET class failed: ${resp.status}`);
        return resp.body;
    }
    /** Create a transport request */
    async createTransportRequest(description, targetSystem) {
        const desc = (description || "RAP Migration").slice(0, 60);
        // Try multiple XML formats — different SAP versions accept different formats
        const bodies = [
            // Format 1: Short attribute style
            `<?xml version="1.0" encoding="utf-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:category="Workbench" tm:desc="${desc}"/>`,
            // Format 2: With target
            `<?xml version="1.0" encoding="utf-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:category="Workbench" tm:target="${targetSystem || ""}" tm:desc="${desc}"/>`,
            // Format 3: Expanded
            `<?xml version="1.0" encoding="utf-8"?>
<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"
  tm:category="Workbench"
  tm:desc="${desc}">
</tm:root>`,
        ];
        for (const body of bodies) {
            try {
                const resp = await this.post("/sap/bc/adt/cts/transportrequests", body, "application/vnd.sap.adt.transportorganizer.transportrequest+xml");
                if (resp.status === 201) {
                    const location = resp.headers["location"];
                    const match = location?.match(/([A-Z0-9]{3}K[0-9]{6})/);
                    if (match)
                        return match[1];
                    // Try parsing from body
                    const bodyMatch = resp.body.match(/([A-Z0-9]{3}K[0-9]{6})/);
                    if (bodyMatch)
                        return bodyMatch[1];
                }
            }
            catch {
                continue;
            }
        }
        throw new Error("Transport creation failed on all attempts.\n" +
            "Please create transport manually in SE09:\n" +
            "  SE09 → Create → Workbench Request → note the number\n" +
            "Then pass that number as transport parameter.");
    }
    /** Activate objects */
    async activateObjects(objects) {
        const items = objects
            .map((o) => `<adtcore:objectReference adtcore:type="${o.type}" adtcore:name="${o.name.toUpperCase()}"/>`)
            .join("\n");
        const body = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${items}
</adtcore:objectReferences>`;
        const resp = await this.post("/sap/bc/adt/activation", body);
        if (resp.status === 200)
            return { success: true, messages: [] };
        // Parse error XML minimally
        const msgs = [];
        const msgMatches = resp.body.matchAll(/<msg[^>]*>([^<]+)<\/msg>/g);
        for (const m of msgMatches)
            msgs.push(m[1]);
        return { success: false, messages: msgs.length ? msgs : [resp.body.slice(0, 400)] };
    }
    /** Write ABAP object source via ADT REST PUT */
    async writeObjectSource(objectType, objectName, source, transport) {
        const typeMap = {
            PROG: "programs/programs",
            CLAS: "oo/classes",
            DDLS: "ddic/ddlsources",
            BDEF: "bo/behaviordefinitions",
            INTF: "oo/interfaces",
        };
        const typeSegment = typeMap[objectType] || objectType.toLowerCase();
        const path = `/sap/bc/adt/${typeSegment}/${objectName.toLowerCase()}/source/main?sap-client=${this.config.client}`;
        const resp = await this.put(path + `&corrNr=${transport}`, source);
        if (resp.status !== 200 && resp.status !== 204) {
            throw new Error(`Write failed for ${objectName}: HTTP ${resp.status}\n${resp.body.slice(0, 300)}`);
        }
    }
}
