import { isInsertableCopyItem, type CopyItem, type CopySelection } from "./copy-items.ts";
import type { PickerController } from "./picker-controller.ts";

type SelectKey = `tui.select.${"cancel" | "confirm" | "up" | "down" | "pageUp" | "pageDown"}`;
type PickerInputOptions = {
	controller: PickerController;
	copyItems: readonly CopyItem[];
	keybindings: { matches(data: string, key: SelectKey): boolean };
	matchesKey(data: string, key: "right" | "backspace"): boolean;
	printableInput(data: string): string | undefined;
};

/** null cancels; undefined leaves the picker open; a selection completes it. */
export function handlePickerInput(data: string, options: PickerInputOptions): CopySelection | null | undefined {
	const { controller, copyItems, keybindings, matchesKey, printableInput } = options;
	if (keybindings.matches(data, "tui.select.cancel")) return null;
	const copy = keybindings.matches(data, "tui.select.confirm");
	if (copy || matchesKey(data, "right")) {
		const index = controller.selectedCopyItemIndex();
		const item = index === undefined ? undefined : copyItems[index];
		if (item && (copy || isInsertableCopyItem(item))) return { item, action: copy ? "copy" : "insert" };
		return undefined;
	}
	if (matchesKey(data, "backspace")) {
		if (controller.filter.length > 0) controller.updateFilter(controller.filter.slice(0, -1));
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.up")) {
		controller.moveSelection(-1, true);
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.down")) {
		controller.moveSelection(1, true);
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.pageUp")) {
		controller.pageSelection(-1);
		return undefined;
	}
	if (keybindings.matches(data, "tui.select.pageDown")) {
		controller.pageSelection(1);
		return undefined;
	}
	const printable = printableInput(data);
	if (printable) controller.updateFilter(controller.filter + printable);
	else controller.handleListInput(data);
	return undefined;
}
