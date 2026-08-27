import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";
const STOP_MARKER = "PI_SKILLSET_PROBE_STOP";

export default function (pi: ExtensionAPI) {
  const bootstrapOutput = process.env.PI_SUPERPOWERS_BOOTSTRAP_OUTPUT;
  const toolsetOutput = process.env.PI_TOOLSET_PROBE_OUTPUT;

  pi.registerCommand("write-skillset-probe", {
    description: "Write loaded skill-set resources for a Nix runtime check",
    handler: async (_args, ctx) => {
      const output = process.env.PI_SKILLSET_PROBE_OUTPUT;
      if (!output) {
        throw new Error("PI_SKILLSET_PROBE_OUTPUT is required");
      }

      const options = ctx.getSystemPromptOptions();
      writeFileSync(
        output,
        JSON.stringify({
          skills: (options.skills ?? []).map((skill) => skill.name).sort(),
          appendSystemPrompt: options.appendSystemPrompt ?? "",
        }),
      );
    },
  });

  pi.registerCommand("write-toolset-probe", {
    description: "Write registered and active tools for a Nix runtime check",
    handler: async () => {
      if (!toolsetOutput) {
        throw new Error("PI_TOOLSET_PROBE_OUTPUT is required");
      }

      writeFileSync(
        toolsetOutput,
        JSON.stringify({
          all: pi.getAllTools().map((tool) => tool.name).sort(),
          active: pi.getActiveTools().sort(),
        }),
      );
    },
  });

  pi.on("context", async (event) => {
    if (bootstrapOutput && event.messages.some(messageContainsBootstrap)) {
      writeFileSync(bootstrapOutput, `${BOOTSTRAP_MARKER}\n`);
    }
  });

  pi.on("before_provider_request", () => {
    if (bootstrapOutput || toolsetOutput) {
      throw new Error(STOP_MARKER);
    }
  });
}

function messageContainsBootstrap(message: unknown): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.includes(BOOTSTRAP_MARKER);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) => {
    return (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes(BOOTSTRAP_MARKER)
    );
  });
}
