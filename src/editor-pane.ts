// One editor pane for a whole `luuna-roots flow` (tmux only). The first think
// session opens $EDITOR in a split and remembers the pane id; later sessions
// switch that pane to the next idea.md instead of opening another split.
// Switching is done only for vim-family editors still running in the pane:
// roots sends `:update | edit <file>` (write the old buffer if changed, then
// open the new file). Otherwise (other editors, the pane was closed, zellij,
// no multiplexer) it falls back to launchEditorSplit's new-pane behavior.

import { resolveEditor } from "./editor.ts";
import type { Io } from "./io.ts";
import {
	detectMultiplexer,
	launchEditorSplit,
	realSpawner,
	type Spawner,
	type SplitLaunch,
	shellQuote,
} from "./split.ts";

const VIM_FAMILY = new Set(["vi", "vim", "nvim"]);

export function isVimFamily(editor: string): boolean {
	const program = editor.trim().split(/\s+/)[0] ?? "";
	return VIM_FAMILY.has(program.split("/").pop() ?? "");
}

export interface EditorPane {
	/** tmux pane id (e.g. %12) of the editor pane, once opened. */
	id: string | null;
}

function paneCommand(id: string, cwd: string, spawn: Spawner): string | null {
	const r = spawn(["tmux", "display-message", "-p", "-t", id, "#{pane_current_command}"], cwd);
	return r.status === 0 ? r.stdout.trim() : null;
}

function reuse(pane: EditorPane, editor: string, file: string, cwd: string, spawn: Spawner) {
	if (!pane.id || !isVimFamily(editor)) return false;
	const running = paneCommand(pane.id, cwd, spawn);
	if (!running || !VIM_FAMILY.has(running)) return false;
	const cmd = `:update | edit ${file.replace(/([\\ %#|"])/g, "\\$1")}`;
	const sent = spawn(["tmux", "send-keys", "-t", pane.id, "Escape", cmd, "Enter"], cwd);
	if (sent.status !== 0) return false;
	spawn(["tmux", "select-pane", "-t", pane.id], cwd);
	return true;
}

/** Show `file` (relative to `cwd`) in the flow's editor pane. */
export function showInEditorPane(
	env: Io["env"],
	pane: EditorPane,
	file: string,
	cwd: string,
	spawn: Spawner = realSpawner,
): SplitLaunch {
	if (detectMultiplexer(env) !== "tmux") return launchEditorSplit(env, file, cwd, spawn);
	const editor = resolveEditor(env);
	if (reuse(pane, editor, file, cwd, spawn)) return { mux: "tmux", ok: true };
	const argv = ["tmux", "split-window", "-h", "-P", "-F", "#{pane_id}", "-c", cwd];
	const r = spawn([...argv, `${editor} ${shellQuote(file)}`], cwd);
	pane.id = r.status === 0 ? r.stdout.trim() || null : null;
	return { mux: "tmux", ok: r.status === 0 };
}
