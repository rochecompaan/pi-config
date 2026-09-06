import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	copyItemKindLabel,
	isInsertableCopyItem,
	type CopySelection,
} from "./copy-items.ts";

export type CopyText = (content: string) => Promise<void>;

type ActionContext = Pick<ExtensionCommandContext, "ui">;

export async function performCopyAction(
	ctx: ActionContext,
	selection: CopySelection,
	copyText: CopyText,
): Promise<void> {
	if (selection.action === "copy") {
		try {
			await copyText(selection.item.content);
			ctx.ui.notify(
				`Copied ${copyItemKindLabel(selection.item.kind)} to clipboard.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : "Failed to copy to clipboard.",
				"error",
			);
		}
		return;
	}

	if (!isInsertableCopyItem(selection.item)) {
		ctx.ui.notify("Only code items can be inserted.", "error");
		return;
	}

	const existing = ctx.ui.getEditorText();
	ctx.ui.setEditorText(existing ? `${existing}\n${selection.item.content}` : selection.item.content);
	ctx.ui.notify("Inserted code into editor.", "info");
}
