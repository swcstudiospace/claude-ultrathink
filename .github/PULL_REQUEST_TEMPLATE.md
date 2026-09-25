## Summary

<!-- What changes and why. Link the issue it closes, e.g. "Closes #123". -->

## Hosts affected

<!-- Tick every host whose behavior changes. A change to the shared engine affects all five; a docs- or CI-only change affects none. -->

- [ ] Claude Code
- [ ] Grok Build
- [ ] Hermes Agent
- [ ] Muse
- [ ] Omp

## Checklist

- [ ] `bun run check` passes
- [ ] `bun test` passes
- [ ] `python3 hosts/hermes/bridge_test.py` prints `ok`
- [ ] Docs updated (README, `skills/*/SKILL.md`, command help) for anything a user would notice
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` for a user-visible change
