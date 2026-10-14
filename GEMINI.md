# Gemini repository instructions

Before diagnosing, editing, testing, reviewing, committing, or deploying in
this repository, read these files completely:

1. [`cs.md`](cs.md) — authoritative project hard rules.
2. [`docs/agent-development-guide.md`](docs/agent-development-guide.md) — the
   canonical coding, data/side-effect safety, UI/UX, verification, and release
   workflow.
3. The current `td` ticket, the design spec
   (`docs/gift-tracker-design-Claude.md`), and the latest relevant
   `docs/devlog/` entry.

Run `td usage --new-session` at the beginning of the conversation. Preserve all
unrelated work and the local dev database. Do not commit, push, deploy, mutate
production data, or trigger Gmail, LLM, Shippo, or notification side effects
unless the user explicitly requests that specific action.
