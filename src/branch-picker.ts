/**
 * Branch picker: a bounded, live-filtered list in a focused modal.
 *
 * Why this file exists. `ctx.ui.select` renders one row per option with no
 * viewport and handles only up/down/confirm, so on a monorepo it produces
 * thousands of rendered rows — the original complaint was scrolling "sooooo
 * much". The fix is not to shrink what we pass it; pi already ships the right
 * primitives and this port simply was not using them:
 *
 *   - `ctx.ui.custom(factory)` shows a component with keyboard focus,
 *   - pi-tui's `SelectList(items, maxVisible, theme)` has a bounded viewport
 *     (it renders at most `maxVisible` rows plus scroll position) and a
 *     `setFilter()` that narrows the list in place.
 *
 * So: type to filter live, arrows scroll a fixed-height window, Enter selects.
 * `SelectList.handleInput` consumes only up/down/Enter/Escape, so every other
 * key is ours and printable characters can drive the filter directly.
 *
 * This is terminal-only. Callers must guard on `ctx.mode === "tui"` and fall
 * back to the input-then-select flow elsewhere (RPC has dialogs but no custom
 * components).
 */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getKeybindings, Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";

/** How many rows the list shows at once. The rest scroll. */
const VISIBLE_ROWS = 12;

export interface BranchChoice {
	value: string;
	/** Short annotation shown after the name, e.g. "local · 2h ago". */
	description?: string;
}

/**
 * A filter box above a fixed-height SelectList.
 *
 * Filtering is done here rather than through `SelectList.setFilter`, because
 * that method matches with `startsWith`. Branch names are long and structured
 * (`release/prod-2025`, `scott.meyer/embedded-app-config-api`), so a prefix
 * match would force you to type the whole leading path before anything narrowed
 * — useless for the case this picker exists to solve. Case-insensitive
 * substring is what people expect from a filter box, and it stays predictable
 * where fuzzy scoring would surprise.
 *
 * Since `items` is private and there is no setter, a filter change rebuilds the
 * list. That is just an array and an index, and it keeps the bounded viewport
 * and rendering that SelectList already gets right.
 *
 * The filter text itself is owned by pi-tui's `Input`, not by hand-rolled key
 * handling. That is not ceremony — `Input` decodes things a naive
 * `data.length === 1` check silently drops:
 *
 *   - bracketed paste (`\x1b[200~ ... \x1b[201~`) arrives as one multi-character
 *     event, so a pasted branch name would vanish entirely;
 *   - terminals with the Kitty protocol send CSI-u even for plain printable
 *     keys (`\x1b[97u` for `a`), so the filter would never update at all there;
 *   - plus cursor movement, word deletion, undo and kill-ring, which people
 *     expect from anything that looks like a text field.
 */
class BranchPickerComponent implements Component {
	private list: SelectList;
	private matches: BranchChoice[];
	private readonly input = new Input();
	private readonly total: number;

	constructor(
		private readonly title: string,
		private readonly choices: BranchChoice[],
		private readonly tui: TUI,
		private readonly done: (result: string | undefined) => void,
	) {
		this.total = choices.length;
		this.matches = choices;
		this.list = this.buildList(choices);
		// This component owns focus, so the child field never gets it from the TUI.
		this.input.focused = true;
		// Enter confirms the highlighted row; Escape cancels the whole picker.
		this.input.onSubmit = () => this.confirmSelection();
		this.input.onEscape = () => this.done(undefined);
	}

	private get filter(): string {
		return this.input.getValue();
	}

	private confirmSelection(): void {
		const item = this.list.getSelectedItem();
		if (item) this.done(item.value);
	}

	private buildList(items: BranchChoice[]): SelectList {
		const list = new SelectList(
			items.map((c) => ({ value: c.value, label: c.value, description: c.description })),
			VISIBLE_ROWS,
			getSelectListTheme(),
		);
		list.onSelect = (item) => this.done(item.value);
		list.onCancel = () => this.done(undefined);
		return list;
	}

	/** Re-filter from whatever the Input now holds. */
	private syncFilter(): void {
		const needle = this.filter.toLowerCase();
		const next = needle ? this.choices.filter((c) => c.value.toLowerCase().includes(needle)) : this.choices;
		// Only rebuild when the result actually changed, so cursor movement inside
		// the filter text does not reset the highlighted row.
		if (next.length !== this.matches.length || next.some((c, i) => c.value !== this.matches[i]?.value)) {
			this.matches = next;
			this.list = this.buildList(next);
		}
		this.tui.requestRender();
	}

	/**
	 * Every line MUST fit the terminal width. This is not cosmetic: pi's main
	 * screen throws when a changed line's visibleWidth exceeds the width (see
	 * TuiMainScreen.renderNow, whose error text names "a custom TUI component not
	 * truncating its output"), and because that throw happens inside a
	 * process.nextTick render callback, InteractiveMode's uncaughtException
	 * handler exits the process. An over-wide line here does not garble the
	 * display, it kills the user's session.
	 *
	 * `Input.render` and `SelectList.render` already truncate themselves. The
	 * three lines this component builds by hand did not, and all three are
	 * reachable in ordinary use: the title carries a branch name of unbounded
	 * length (the monorepo names this picker exists for run 45+ characters), the
	 * no-match line grows one column per character of filter text and `Input`
	 * accepts bracketed paste, and the footer hint is a fixed 54 columns so any
	 * narrower terminal crashed unconditionally.
	 *
	 * `fit` is mapped over the delegated lines too, even though `Input` and
	 * `SelectList` truncate themselves. Their self-truncation has a 2-column floor
	 * (they return a bare `"> "` prefix when `width - 2 <= 0`), and `Input` splices
	 * its fake cursor at a string index, which can split an escape sequence pasted
	 * into the filter and leak literal columns. Those are pi-tui's to fix; mapping
	 * `fit` costs nothing and makes the invariant hold here for every width.
	 */
	render(width: number): string[] {
		const fit = (line: string): string => truncateToWidth(line, width, "…");
		const count = this.filter ? `  (${this.matches.length} of ${this.total})` : `  (${this.total} branches)`;
		const body =
			this.matches.length === 0
				? [fit(`  no branch contains "${this.filter}" — ⌫ to widen, ctrl+u to clear`)]
				: this.list.render(width);
		return [
			fit(`${this.title}${count}`),
			...this.input.render(width).map(fit),
			"",
			...body.map(fit),
			"",
			fit("  ↑↓ move · type to filter · enter select · esc cancel"),
		];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// List navigation.
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.list.handleInput(data);
			this.tui.requestRender();
			return;
		}

		// Enter confirms the highlighted row. Handled here rather than left to
		// `Input.onSubmit` because Input submits on `tui.input.submit` or "\n",
		// while terminals commonly send "\r" — which would otherwise fall through
		// to the field and do nothing at all. A newline in a single-line filter is
		// meaningless anyway, so both spellings mean "select".
		if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
			this.confirmSelection();
			return;
		}

		// Everything else — printable keys, pastes, CSI-u sequences, cursor and word
		// motions, Escape — goes to the Input, which knows how to decode all of it.

		this.input.handleInput(data);
		this.syncFilter();
	}

	invalidate(): void {
		this.list.invalidate();
		this.input.invalidate();
	}
}

/** Minimal shape of what this needs from the command context. */
export interface CustomUiHost {
	mode: string;
	ui: {
		custom<T>(
			factory: (
				tui: TUI,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component & { dispose?(): void },
		): Promise<T>;
	};
}

/**
 * True when custom components can be shown (terminal only).
 *
 * Callers generally should not need this: index.ts checks `ctx.mode` itself so
 * that it can avoid importing this module — and therefore avoid resolving
 * pi-tui — when there is no terminal.
 */
export function canShowCustomUi(ctx: { mode?: string }): boolean {
	return ctx.mode === "tui";
}

/**
 * Show the picker. Resolves to the chosen branch, or undefined when cancelled.
 */
export function pickFromList(
	ctx: CustomUiHost,
	title: string,
	choices: BranchChoice[],
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(
		(tui, _theme, _keybindings, done) => new BranchPickerComponent(title, choices, tui, done),
	);
}
