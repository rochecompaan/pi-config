import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Local fork of:
 * https://raw.githubusercontent.com/michalvavra/agents/refs/heads/main/agents/pi/extensions/filter-output.ts
 *
 * Filter or transform tool results before the LLM sees them.
 * Redacts sensitive data like API keys, tokens, passwords, etc.
 */
export default function (pi: ExtensionAPI) {
  const sensitivePatterns = [
    { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, replacement: "[OPENAI_KEY_REDACTED]" },
    { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, replacement: "[GITHUB_TOKEN_REDACTED]" },
    { pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g, replacement: "[GITHUB_OAUTH_REDACTED]" },
    { pattern: /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g, replacement: "[SLACK_TOKEN_REDACTED]" },
    { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "[AWS_KEY_REDACTED]" },
    {
      pattern: /\b(api[_-]?key|apikey)\s*[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
      replacement: "$1=[REDACTED]",
    },
    {
      pattern: /\b(secret|token|password|passwd|pwd)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
      replacement: "$1=[REDACTED]",
    },
    { pattern: /\b(bearer)\s+([a-zA-Z0-9._-]{20,})\b/gi, replacement: "Bearer [REDACTED]" },
    { pattern: /(mongodb(\+srv)?:\/\/[^:]+:)[^@]+(@)/gi, replacement: "$1[REDACTED]$3" },
    { pattern: /(postgres(ql)?:\/\/[^:]+:)[^@]+(@)/gi, replacement: "$1[REDACTED]$3" },
    { pattern: /(mysql:\/\/[^:]+:)[^@]+(@)/gi, replacement: "$1[REDACTED]$3" },
    { pattern: /(redis:\/\/[^:]+:)[^@]+(@)/gi, replacement: "$1[REDACTED]$3" },
    {
      pattern:
        /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
      replacement: "[PRIVATE_KEY_REDACTED]",
    },
  ];

  const sensitiveFiles = [
    /\.env$/,
    /\.env\.(?!example$)[^/]+$/,
    /\.dev\.vars($|\.[^/]+$)/,
    /secrets?\.(json|ya?ml|toml)$/i,
    /credentials/i,
  ];

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;

    const textContent = event.content.find(
      (content): content is { type: "text"; text: string } => content.type === "text",
    );
    if (!textContent) return undefined;

    let result = textContent.text;
    let wasModified = false;

    if (event.toolName === "read") {
      const filePath = String(event.input.path ?? "").replace(/^@/, "");
      if (/(^|\/)\.env\.example$/i.test(filePath)) {
        return undefined;
      }

      for (const pattern of sensitiveFiles) {
        if (pattern.test(filePath)) {
          if (ctx.hasUI) {
            ctx.ui.notify(`🔒 Redacted contents of sensitive file: ${filePath}`, "info");
          }
          return {
            content: [{ type: "text", text: `[Contents of ${filePath} redacted for security]` }],
          };
        }
      }
    }

    for (const { pattern, replacement } of sensitivePatterns) {
      const newResult = result.replace(pattern, replacement);
      if (newResult !== result) {
        wasModified = true;
        result = newResult;
      }
    }

    if (wasModified) {
      if (ctx.hasUI) {
        ctx.ui.notify("🔒 Sensitive data redacted from output", "info");
      }
      return { content: [{ type: "text", text: result }] };
    }

    return undefined;
  });
}
