## Summary

<!-- What changes and why. Link the issue it closes, e.g. "Closes #123". -->

## Hosts affected

<!-- Tick every host whose behavior changes. The list matches the Hosts table in the README plus the Grok Bot adapter. A change to the shared engine affects the six hosts that run it (Grok Bot does not); a docs- or CI-only change affects none. -->

- [ ] Claude Code
- [ ] Grok Build
- [ ] Hermes Agent
- [ ] Muse Code
- [ ] Prime Agent
- [ ] Omp
- [ ] Grok Bot (skill adapter)

## Checklist

- [ ] `bun run verify` passes (type check, `bun test` and both bridge tests)
- [ ] `bun run check` passes
- [ ] `bun test` passes
- [ ] `python3 hosts/hermes/bridge_test.py` prints `ok`
- [ ] `python3 hosts/prime-agent/bridge_test.py` passes
- [ ] Docs updated (README, `skills/*/SKILL.md`, command help) for anything a user would notice
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` for a user-visible change
