import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clampScroll, type PinData } from "./pin-state.ts";

/** Rows used by the frame: top border, title, rule, rule, hint, bottom border. */
const CHROME_ROWS = 6;
const HEIGHT_RATIO = 0.8;

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Open the pinned reply in a scrollable overlay. Resolves when the user closes it. */
export function openPinViewer(ctx: ExtensionContext, pin: PinData): Promise<void> {
	return ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const markdown = new Markdown(pin.text, 0, 0, getMarkdownTheme());
			let offset = 0;
			let viewHeight = 1;
			let totalLines = 0;

			const border = (text: string) => theme.fg("borderAccent", text);
			const hint = (key: string, action: string) => `${theme.fg("accent", key)} ${theme.fg("muted", action)}`;

			const scrollTo = (next: number) => {
				const clamped = clampScroll(next, totalLines, viewHeight);
				if (clamped !== offset) {
					offset = clamped;
					tui.requestRender();
				}
			};

			return {
				render: (width: number) => {
					const inner = Math.max(1, width - 4);
					const frame = (content: string) => {
						const cut = truncateToWidth(content, inner, "");
						return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
					};
					const rule = border(`├${"─".repeat(width - 2)}┤`);

					const body = markdown.render(inner);
					totalLines = body.length;
					const rows = tui.terminal.rows || 24;
					const maxView = Math.max(1, Math.floor(rows * HEIGHT_RATIO) - CHROME_ROWS);
					viewHeight = Math.min(maxView, Math.max(1, totalLines));
					offset = clampScroll(offset, totalLines, viewHeight);

					const visible = body.slice(offset, offset + viewHeight);
					while (visible.length < viewHeight) visible.push("");

					const title = theme.fg("borderAccent", theme.bold(`📌 Pinned · ${formatTime(pin.pinnedAt)}`));
					const hints = [hint("↑↓/jk", "scroll"), hint("PgUp/PgDn", "page"), hint("Home/End", "jump"), hint("Esc/q", "close")];
					if (totalLines > viewHeight) {
						const last = Math.min(totalLines, offset + viewHeight);
						hints.unshift(theme.fg("dim", `${offset + 1}–${last} of ${totalLines}`));
					}

					return [
						border(`╭${"─".repeat(width - 2)}╮`),
						frame(title),
						rule,
						...visible.map(frame),
						rule,
						frame(hints.join(theme.fg("dim", " · "))),
						border(`╰${"─".repeat(width - 2)}╯`),
					];
				},
				invalidate: () => markdown.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || data === "q") return done();
					if (matchesKey(data, "up") || data === "k") return scrollTo(offset - 1);
					if (matchesKey(data, "down") || data === "j") return scrollTo(offset + 1);
					if (matchesKey(data, "pageUp")) return scrollTo(offset - viewHeight);
					if (matchesKey(data, "pageDown") || data === " ") return scrollTo(offset + viewHeight);
					if (matchesKey(data, "home") || data === "g") return scrollTo(0);
					if (matchesKey(data, "end") || data === "G") return scrollTo(totalLines);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
		},
	);
}
