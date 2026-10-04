import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Inspect the final provider input: context handlers can run before Superpowers.
// A local stream callback fails before any network request can occur.
export default function (pi: ExtensionAPI) {
  pi.registerProvider("pi-bootstrap-probe", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "local-probe-only",
    models: [{
      id: "probe",
      name: "Bootstrap probe",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 1,
    }],
    streamSimple: (_model, context) => {
      const output = process.env.PI_BOOTSTRAP_PROBE_OUTPUT;
      if (!output) throw new Error("PI_BOOTSTRAP_PROBE_OUTPUT is required");
      const serialized = JSON.stringify(context);
      writeFileSync(output, JSON.stringify({
        bootstrap: JSON.stringify(context.messages).includes(
          "superpowers:using-superpowers bootstrap for pi",
        ),
        skills: [...new Set(
          [...serialized.matchAll(/<skill>[\s\S]*?<name>([^<]+)<\/name>/g)]
            .map((match) => match[1]),
        )].sort(),
        all: pi.getAllTools().map((tool) => tool.name).sort(),
        active: pi.getActiveTools().sort(),
        modelTools: (context.tools ?? []).map((tool) => tool.name).sort(),
      }));
      throw new Error("PI_BOOTSTRAP_PROBE_STOP");
    },
  });
}
