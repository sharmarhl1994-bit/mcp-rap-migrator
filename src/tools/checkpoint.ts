/**
 * human_checkpoint — MANDATORY between every agent step.
 * Returns a formatted display for the human to read.
 * The MCP client (Cline/Claude Code) will surface this text.
 * Human must respond YES / MODIFY <instructions> / ABORT.
 */

interface CheckpointArgs {
  step_title:   string;
  what_i_got:   string;
  my_analysis:  string;
  next_action:  string;
  code_preview?: string;
}

export async function humanCheckpoint(args: CheckpointArgs) {
  const divider = "━".repeat(60);

  const lines = [
    divider,
    `🔔  CHECKPOINT: ${args.step_title}`,
    divider,
    "",
    "📥  WHAT I GOT:",
    args.what_i_got,
    "",
    "🧠  MY ANALYSIS:",
    args.my_analysis,
    "",
    "⏭️   NEXT ACTION (pending your approval):",
    args.next_action,
  ];

  if (args.code_preview) {
    lines.push("", "👀  CODE PREVIEW (first 50 lines):", "```abap", args.code_preview.split("\n").slice(0, 50).join("\n"), "```");
  }

  lines.push(
    "",
    divider,
    "💬  REPLY WITH:",
    "  YES            — proceed with next action",
    "  MODIFY <text>  — change something first",
    "  ABORT          — stop migration",
    divider
  );

  return {
    content: [{
      type: "text",
      text: lines.join("\n"),
    }],
  };
}
