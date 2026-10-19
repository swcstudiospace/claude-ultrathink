# Ultrathink Connector (Claude plugin)

This plugin lets you plan a request from Claude chat with ultrathink. It bundles six commands, one skill with the playbook for the connector's tools, and the connector entry for the hosted server at `https://ultrathink.swcstudio.space/mcp`. A plan has a wave tree, a Graph of Thought diagram and clarifying questions, each with a default; Claude shows the tree first, asks the questions that matter, then carries out the plan.

Data: the request text you give a command goes to the ultrathink server through the connector, and the plan comes back. The plugin stores nothing itself and contains no key, header or token. The connector signs in by OAuth: you enter the server owner's password on a consent page.

## Commands

| Command | What it does | Argument |
|---|---|---|
| `/ultrathink` | Plans the request. | `<request>` |
| `/ultrathink-plan` | Same as `/ultrathink`. | `<request>` |
| `/ultrathink-think` | Shows a plan's diagram, tree or one node. | `[sessionId] [node]` |
| `/ultrathink-last` | Shows the newest planned session with its diagram. | none |
| `/ultrathink-status` | Shows the planning mode, ceilings and recent sessions. | none |
| `/ultrathink-quick` | Answers a message directly, without planning. | `<message>` |

Where Claude namespaces plugin commands, they appear as `/ultrathink-connector:<name>`. Commands that need a plugin host (tracking, shipping, Teachable Moments, operator controls) are not part of the connector; the skill tells Claude to explain that if you type one.

## Install on claude.ai and Claude Desktop chat

1. Build the archive with `sh plugins/ultrathink-connector/package.sh` from the repository root. It writes `plugins/ultrathink-connector/dist/ultrathink-connector-<version>.zip`.
2. In claude.ai or Claude Desktop, open **Customize > Plugins > Add > Upload plugin** and select the zip.
3. Open the plugin, select its **Connectors** tab, then add and connect `ultrathink`. Sign in with the owner password on the consent page and approve.
4. In a chat, pick a command from the "/" menu, for example `/ultrathink plan a CSV export`. Or ask Claude which skills it has from plugins and ask for a plan.

On Team and Enterprise plans an Owner may have to add the connector for the organization first.

## Install in Cowork and Claude Code

Run `claude --plugin-dir plugins/ultrathink-connector` from the repository root. Skills and commands appear as `/ultrathink-connector:<name>`, and `/mcp` shows the connector's connection state; authenticate there. In Cowork, connect the connector from the plugin's **Connectors** tab. Claude Code can also use the hosted server without this plugin; see `docs/how-to/use-ultrathink-in-chat.md`.

## Use your own deployment

The URL in `.mcp.json` is the operator's production server. To point the plugin at your own deployment, change `url` to `https://<your-host>/mcp` and build the archive again. Keep the file free of keys and headers: everyone who installs the plugin receives it.

## Not verified live

The connector has not been connected to Claude chat or Claude Code from this plugin in a live session. These follow the Claude plugin documentation (`https://claude.com/docs/plugins/build`, `https://claude.com/docs/plugins/platform-support`) and are not tried here:

- That the commands appear in the "/" menu and that picking one runs it. In chat a command loads as a skill that Claude applies when it fits; a typed `/ultrathink foo` that is not picked from the menu is plain text.
- That `$ARGUMENTS` is filled in when chat loads a command as a skill. The command files fall back to the text you typed.
- That the Connectors tab lists the connector, accepts the owner-password sign-in, and then exposes all ten tools, including the new `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command`.
- That MCP App rendering of the diagram works in custom connectors. Reports say it is inconsistent, so the commands ask Claude to show the mermaid block as text.
- The upload size and file limits for your plan (the documentation gives 200 MB and 5,000 files for chat).

Hosted Claude chat does not deliver the server's `instructions`, which is why the playbook is in the skill and the commands.

## License

AGPL-3.0-or-later, as the rest of the repository.
