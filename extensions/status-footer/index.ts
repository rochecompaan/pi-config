import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

import { registerStatusFooter } from "./extension.ts";

export default function statusFooterExtension(pi: ExtensionAPI): void {
	registerStatusFooter(pi, { now: Date.now, truncateToWidth });
}
