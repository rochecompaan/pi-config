import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const modelsetOutput = process.env.PI_MODELSET_PROBE_OUTPUT;
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

  pi.registerCommand("write-modelset-probe", {
    description: "Write available Claude bridge models for a Nix runtime check",
    handler: async (_args, ctx) => {
      if (!modelsetOutput) {
        throw new Error("PI_MODELSET_PROBE_OUTPUT is required");
      }

      writeFileSync(
        modelsetOutput,
        JSON.stringify(
          ctx.modelRegistry
            .getAvailable()
            .filter((model) => model.provider === "claude-bridge")
            .map((model) => ({
              provider: model.provider,
              id: model.id,
              contextWindow: model.contextWindow,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
      );
    },
  });
}
