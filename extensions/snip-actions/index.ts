import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { performCopyAction } from "./actions.ts";
import {
	collectCopyItems,
	type BranchEntry,
	type CopyItem,
	type CopySelection,
} from "./copy-items.ts";
import { pickCopyItem } from "./ui.ts";

export type SnipActionsDependencies = {
	pickCopyItem(
		ctx: ExtensionCommandContext,
		items: CopyItem[],
	): Promise<CopySelection | undefined>;
	performAction(
		ctx: ExtensionCommandContext,
		selection: CopySelection,
	): Promise<void>;
};

const defaultDependencies: SnipActionsDependencies = {
	pickCopyItem,
	performAction: (ctx, selection) => performCopyAction(ctx, selection, copyToClipboard),
};

export function registerSnipActions(
	pi: ExtensionAPI,
	dependencies: SnipActionsDependencies = defaultDependencies,
): void {
	pi.registerCommand("snip", {
		description: "Pick an assistant message or code item to copy or insert.",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				if (ctx.hasUI) ctx.ui.notify("/snip requires interactive mode.", "warning");
				return;
			}

			const items = collectCopyItems(ctx.sessionManager.getBranch() as BranchEntry[]);
			if (items.length === 0) {
				ctx.ui.notify("No assistant messages to copy.", "warning");
				return;
			}

			const selection = await dependencies.pickCopyItem(ctx, items);
			if (!selection) return;
			await dependencies.performAction(ctx, selection);
		},
	});
}

export default registerSnipActions;
