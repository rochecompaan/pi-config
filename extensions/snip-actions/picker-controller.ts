import type { CopyItem } from "./copy-items.ts";
import { buildCopyItemPreview, type CopyItemPreview } from "./preview.ts";
import { rankedFilterItems, type SearchIndexItem } from "./search.ts";

export type PickerListItem = {
	value: string;
	label: string;
	description?: string;
};

export type PickerListAdapter = {
	getSelectedItem(): PickerListItem | undefined;
	replaceItems(items: PickerListItem[]): void;
	setSelectedIndex(index: number): void;
	handleInput(data: string): void;
	invalidate(): void;
};

type PickerControllerOptions = {
	copyItems: readonly CopyItem[];
	selectItems: PickerListItem[];
	searchIndex: SearchIndexItem[];
	list: PickerListAdapter;
	showPreview(preview: CopyItemPreview): void;
	showFilter(filter: string): void;
	requestRender(): void;
};

export class PickerController {
	private readonly options: PickerControllerOptions;
	private filterValue = "";
	private filteredItems: PickerListItem[];

	constructor(options: PickerControllerOptions) {
		this.options = options;
		this.filteredItems = options.selectItems;
	}

	get filter(): string {
		return this.filterValue;
	}

	initialize(): void {
		this.options.showFilter(this.filterValue);
		this.updatePreview();
	}

	refresh(): void {
		this.options.showFilter(this.filterValue);
		this.updatePreview();
	}

	updateFilter(next: string): void {
		this.filterValue = next;
		this.filteredItems = rankedFilterItems(
			next,
			this.options.selectItems,
			this.options.searchIndex,
		);
		this.options.list.replaceItems(this.filteredItems);
		this.options.list.invalidate();
		this.options.showFilter(this.filterValue);
		this.updatePreview();
		this.options.requestRender();
	}

	moveSelection(offset: number, wrap: boolean): void {
		if (this.filteredItems.length === 0) return;
		const selected = this.options.list.getSelectedItem();
		const currentIndex = selected ? Math.max(this.filteredItems.indexOf(selected), 0) : 0;
		const candidate = currentIndex + offset;
		const nextIndex = wrap
			? (candidate + this.filteredItems.length) % this.filteredItems.length
			: Math.max(0, Math.min(candidate, this.filteredItems.length - 1));
		this.options.list.setSelectedIndex(nextIndex);
		this.updatePreview();
		this.options.requestRender();
	}

	handleListInput(data: string): void {
		this.options.list.handleInput(data);
		this.updatePreview();
		this.options.requestRender();
	}

	selectedCopyItemIndex(): number | undefined {
		const value = this.options.list.getSelectedItem()?.value;
		if (value === undefined) return undefined;
		const index = Number.parseInt(value, 10);
		return Number.isNaN(index) ? undefined : index;
	}

	private updatePreview(): void {
		const value = this.options.list.getSelectedItem()?.value;
		this.options.showPreview(buildCopyItemPreview(this.options.copyItems, value));
	}
}
