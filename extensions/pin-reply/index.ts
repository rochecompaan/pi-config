/**
 * Pin a reply: keep one assistant reply at hand while the conversation moves on.
 *
 * - /pin      save the last assistant reply (replaces any existing pin)
 * - /pinned   open the pinned reply in a scrollable overlay (also ctrl+alt+p)
 * - /unpin    release the pin
 *
 * The pin is stored as a custom session entry, so it never reaches the model,
 * survives /reload and resume, and follows /tree branches.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PIN_ENTRY_TYPE, currentPin, lastReplyText, type PinData, type PinEntryData } from "./pin-state.ts";
import { openPinViewer } from "./viewer.ts";

const STATUS_KEY = "pin-reply";
const PREVIEW_CHARS = 60;

function preview(text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
	const clean = firstLine.replace(/^[#>*\-\s]+/, "").trim();
	return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS - 1)}…` : clean;
}

export default function pinReply(pi: ExtensionAPI) {
	let pin: PinData | undefined;

	const show = (ctx: ExtensionContext, next: PinData | undefined) => {
		pin = next;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, pin ? ctx.ui.theme.fg("accent", "📌 pinned") : undefined);
	};

	const refresh = (ctx: ExtensionContext) => show(ctx, currentPin(ctx.sessionManager.getBranch()));

	const save = (ctx: ExtensionContext, data: PinEntryData) => {
		pi.appendEntry(PIN_ENTRY_TYPE, data);
		show(ctx, "cleared" in data ? undefined : data);
	};

	const open = async (ctx: ExtensionContext) => {
		if (!pin) {
			ctx.ui.notify("Nothing is pinned. Use /pin to pin the last reply.", "info");
			return;
		}
		await openPinViewer(ctx, pin);
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));

	pi.registerCommand("pin", {
		description: "Pin the last assistant reply (replaces any existing pin)",
		handler: async (_args, ctx) => {
			const text = lastReplyText(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify("No assistant reply to pin.", "warning");
				return;
			}
			const replaced = Boolean(pin);
			save(ctx, { text, pinnedAt: Date.now() });
			ctx.ui.notify(`${replaced ? "Replaced pin" : "Pinned"}: ${preview(text)}`, "info");
		},
	});

	pi.registerCommand("pinned", {
		description: "Show the pinned reply (ctrl+alt+p)",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerCommand("unpin", {
		description: "Release the pinned reply",
		handler: async (_args, ctx) => {
			if (!pin) {
				ctx.ui.notify("Nothing is pinned.", "info");
				return;
			}
			save(ctx, { cleared: true });
			ctx.ui.notify("Unpinned.", "info");
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Show the pinned reply",
		handler: async (ctx) => open(ctx),
	});
}
