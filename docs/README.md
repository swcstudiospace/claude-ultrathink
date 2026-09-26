# ultrathink documentation

ultrathink plans every non-trivial prompt into a spec and a Graph of Thought before your coding agent starts, and can track the plan in Notion or Linear. New here? Start with [Getting started](getting-started.md).

## Start here

- [Getting started](getting-started.md): from nothing to a first planned prompt, then to a first tracked plan.
- [Install](install.md): install, verify, update and remove ultrathink on Claude Code, Grok Build, Hermes Agent, Muse Code and Omp.
- [What leaves your machine](privacy.md): which services ultrathink contacts, what it sends, and what stays local.
- [FAQ](faq.md): short answers to common questions.

## How-to guides

- [Set up Notion](how-to/set-up-notion.md): log in, create or reuse the tracking database, verify.
- [Set up Linear](how-to/set-up-linear.md): log in with OAuth or an API key, choose the team, verify.
- [Register the MCP gateway](how-to/register-mcp-gateway.md): give every host's agent the Notion, Linear and Greptile tools.
- [Choose the engine](how-to/choose-engine.md): plan with Claude (the default) or Grok.
- [Ship with Greptile](how-to/ship-with-greptile.md): opt in to the pull request, Greptile review and merge flow.
- [Use the Greptile knowledge base](how-to/use-greptile-knowledge-base.md): opt in to reading the repository's Greptile knowledge base before the clarifying questions.
- [Reduce cost and latency](how-to/reduce-cost-and-latency.md): fewer engine calls per prompt, or none for small messages.
- [Headless and CI](how-to/headless-and-ci.md): run hosts in scripts without planning or tracking.
- [Team and project config](how-to/team-and-project-config.md): share settings per repository and layer them with your own.
- [Upgrade and move](how-to/upgrade-and-move.md): update each host and move the clone.
- [Uninstall](how-to/uninstall.md): remove ultrathink from each host, plus its shared config, credentials and state.

## Reference

- [Configuration](configuration.md): config files, every key and its default, environment variables, state directories.
- [Commands](commands.md): the `/ultrathink-*` commands, prompt prefixes and the `bin/` CLIs.
- [Tracking](tracking.md): the rows ultrathink creates in Notion and Linear, and when.
- [Ship](ship.md): the done check, pull request, review loop and merge gate.
- [Troubleshooting](troubleshooting.md): symptoms, causes and fixes.

## Explanation

- [Architecture](architecture.md): how the engine, host adapters, skills and MCP gateway fit together, and the runtime limits of each host.

## Project

- [Project README](../README.md): what ultrathink is, supported hosts and platforms, optional integrations.
- [Contributing](../CONTRIBUTING.md): development setup, checks and pull requests.
- [Security](../SECURITY.md): reporting vulnerabilities and how credentials are stored.
- [Code of conduct](../CODE_OF_CONDUCT.md): the Contributor Covenant.
- [Changelog](../CHANGELOG.md): release notes.
- [License](../LICENSE): AGPL-3.0-or-later.
