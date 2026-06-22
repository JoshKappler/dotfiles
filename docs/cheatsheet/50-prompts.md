## Prompt library (espanso)

Type a trigger in **any** window and espanso pastes the full prompt (via the
clipboard, so multi-line text lands intact — ideal for the Claude Code CLI).

Press **`Alt+Shift+Space`** to open espanso's built-in **search** UI and pick a
prompt by name when you can't remember the trigger.

| Trigger | Expands to |
|---|---|
| `:plan` | Restate the goal, list the files involved, give a numbered minimal plan, then wait for "OK" before changing code. |
| `:review` | Terse, high-signal review: correctness bugs first, then simplifications — each as `file:line`, no praise. |
| `:commit` | A Conventional Commits message (`type(scope): summary`) generated from the staged diff. |
| `:debug` | Systematic, root-cause-first debugging: reproduce, rank hypotheses, prove the cause, then fix. |
| `:explain` | A clear, concise explanation of unfamiliar code — flow, side effects, edge cases, assumptions. |
| `:test` | Write a failing test first (TDD), confirm it fails for the right reason, then implement to green. |
| `:refactor` | Behavior-preserving cleanup: better names/structure, less duplication, tests still pass. |
| `:tidy` | Low-risk local cleanup of the current file/diff: dead code, stray logs, typos, formatting — no logic changes. |
| `:pr` | A pull-request title plus a Summary / Changes / Testing body built from the actual diff. |
| `:spec` | Turn a rough idea into a tight spec: problem, scope/non-goals, approach, acceptance criteria, open questions. |

> **Note:** these same prompts also exist as **Claude Code slash-commands** in
> `~/.claude/commands` (e.g. `/plan`, `/review`). Use the espanso trigger to paste
> into any app or terminal; use the slash-command for the richer, Claude-native
> version with arguments and file references.
