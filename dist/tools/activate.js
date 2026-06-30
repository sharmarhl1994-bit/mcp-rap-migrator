// Activation order — DDLS first, then BDEF, then CLAS, then rest
const ACTIVATION_ORDER = {
    DDLS: 1,
    BDEF: 2,
    CLAS: 3,
    INTF: 4,
    PROG: 5,
};
export async function validateAndActivate(adt, args) {
    // Sort objects by activation order
    const sorted = [...args.objects].sort((a, b) => {
        const orderA = ACTIVATION_ORDER[a.type.toUpperCase()] || 99;
        const orderB = ACTIVATION_ORDER[b.type.toUpperCase()] || 99;
        return orderA - orderB;
    });
    const names = sorted.map((o) => `${o.type}:${o.name}`).join(", ");
    // Activate one by one in order — safer than batch
    const errors = [];
    const activated = [];
    for (const obj of sorted) {
        const result = await adt.activateObjects([obj]);
        if (result.success) {
            activated.push(`${obj.type}:${obj.name}`);
        }
        else {
            errors.push(`${obj.type}:${obj.name} → ${result.messages.join(", ")}`);
            // Stop on first error — next objects may depend on this one
            break;
        }
    }
    if (errors.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        "✅ ALL ACTIVATED": activated,
                        activation_order: sorted.map(o => `${o.type}:${o.name}`),
                        next: "All objects active in SAP. Call human_checkpoint to confirm.",
                    }, null, 2),
                }],
        };
    }
    return {
        content: [{
                type: "text",
                text: JSON.stringify({
                    "⚠️ PARTIAL ACTIVATION": {
                        activated,
                        failed: errors,
                        stopped_at: errors[0],
                    },
                    suggestion: [
                        "Fix the error in the failed object first",
                        "Then retry write_abap_object for that object",
                        "Then retry validate_and_activate",
                        "Common fixes:",
                        "  - CDS: check field names match source table/view",
                        "  - BDEF: check entity name matches CDS view name exactly",
                        "  - CLAS: check FOR BEHAVIOR OF matches BDEF name exactly",
                    ],
                }, null, 2),
            }],
        isError: true,
    };
}
export async function createTransport(adt, args) {
    try {
        const transportNum = await adt.createTransportRequest(args.description, args.target_system);
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        "✅ TRANSPORT CREATED": transportNum,
                        description: args.description,
                        usage: `Pass this number as 'transport' in all write_abap_object calls.`,
                        next: "Now write objects in order: DDLS → BDEF → CLAS",
                    }, null, 2),
                }],
        };
    }
    catch (e) {
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        "❌ TRANSPORT CREATION FAILED": e.message,
                        manual_fix: [
                            "1. Go to SE09 in SAP",
                            "2. Click Create → Workbench Request",
                            "3. Description: RAP Migration",
                            "4. Save and note the transport number (e.g. I10K906317)",
                            "5. Pass that number as transport parameter in write_abap_object",
                        ],
                    }, null, 2),
                }],
            isError: true,
        };
    }
}
