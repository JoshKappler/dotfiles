# Global preferences (Josh)

My personal defaults for how I want you to work, across every project. Project-level
CLAUDE.md files and explicit instructions always take precedence over this file.

> Reconstructed 2026-06-24 after the original was lost in a crash. It was never tracked
> by chezmoi, so nothing restored it — it is now a managed dotfile so it can't silently
> vanish again. Adjust freely.

## How I build
- Build from scratch over reaching for frameworks. Prefer small, dependency-free
  solutions (language/runtime built-ins) unless a dependency clearly earns its place.
- Get to working code fast — bias toward a running result over extensive up-front design.
- Commit and push without asking once it builds and tests pass. Use the repo's primary
  branch (usually `main`/`master`); keep the git setup as plain and basic as possible.
- Skip trailing "what I changed" summaries. If the diff speaks for itself, don't narrate it.

## Style
- Match the surrounding code's conventions, naming, and comment density.
- Terse and direct. No filler, no flattery, no preamble.

## Environment
- Windows 11 Pro. Primary shell is PowerShell; a Bash (Git Bash) tool is also available
  — each needs its own syntax.
- Hardware: RTX 5080 (16 GB VRAM), 64 GB RAM.
- GitHub: JoshKappler. Repos live under `~/OneDrive/Desktop/projects`.
