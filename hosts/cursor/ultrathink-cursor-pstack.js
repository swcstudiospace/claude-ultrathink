#!/usr/bin/env node
// ultrathink-managed: true
// ultrathink-cursor-pstack.js — Cursor beforeSubmitPrompt hook (phase 24)
//
// Cursor invokes this script when the user submits a prompt.
// Protocol: JSON from Cursor on stdin; one JSON response on stdout.
//
// Input schema (cursor beforeSubmitPrompt):
//   { prompt, conversation_id, generation_id, model, hook_event_name,
//     cursor_version, workspace_roots, user_email, transcript_path }
//
// Output schema (cursor beforeSubmitPrompt):
//   { continue?: boolean, additional_context?: string }
//
// Behaviour:
//   - Detects /gsd-* slash commands in the submitted prompt and, when the
//     user-level ultrathink config enables pstack, injects additional_context
//     telling the agent to run the matching pstack skills alongside the GSD
//     step, then continue the GSD workflow unchanged.
//   - Env: ULTRATHINK_PSTACK=0 is a hard off switch; ULTRATHINK_CONFIG_DIR
//     overrides the user config location; ULTRATHINK_PSTACK_CURSOR_DIR
//     overrides the pstack cache location (default $HOME/.cursor).
//   - Reads only user-level config (never a project file): the first of
//     $ULTRATHINK_CONFIG_DIR/config.json, $HOME/.config/ultrathink/config.json,
//     $HOME/.claude/ultrathink.json that exists and JSON-parses.
//   - Writes nothing to disk, imports nothing beyond node: builtins.
//   - Fails open: any error, missing skill, or doubt prints {} and exits 0 so
//     a hook bug never wedges Cursor.
//
// The embedded table and mapping below are pinned to src/cursor/pstack.ts by
// hosts/cursor/ultrathink-cursor-pstack.test.ts; keep the two in lockstep.

'use strict';

// Embedded data is double-quoted (JSON-compatible) so the parity test can
// extract and JSON.parse it without evaluating hook code.
const COMMAND_STAGE = [
  [/^gsd-discuss-phase$/, "discuss"],
  [/^gsd-(plan-phase|ultraplan-phase|spec-phase)$/, "plan"],
  [/^gsd-(execute-phase|fast|quick|quick-batch)$/, "execute"],
  [/^gsd-(verify-work|code-review|ui-review|audit-uat|audit-fix|audit-milestone)$/, "review"],
  [/^gsd-ship$/, "review"],
  [/^gsd-autonomous$/, "orchestrate"],
];
const ALL_STAGES = ["discuss", "plan", "execute", "review"];

// No trailing commas: the parity test JSON.parses this literal.
const DEFAULT_MAPPING = {
  "discuss": ["how"],
  "plan": ["architect", "arena"],
  "execute": ["tdd"],
  "review": ["interrogate", "no-comments"]
};

const PURPOSES = {
  "how": "read-only walkthrough of how the subsystem works before discussing changes",
  "architect": "settle caller usage, types and module shape before the plan locks a design",
  "arena": "run parallel alternative attempts and keep the best parts before committing to a design",
  "tdd": "write the failing test first, then the fix, while executing",
  "interrogate": "have different models try to break the diff during verification or review",
  "no-comments": "strip comments before review and fix accepted findings during verification or review",
};

const MOMENTS = {
  "discuss": "while gathering context, before proposing the design",
  "plan": "while designing the phase, before the plan is finalized",
  "execute": "while writing the change, test first",
  "review": "while verifying and reviewing the completed change",
};

// ---------- staged-block logic (ported from the phase-23 proof) ----------

const semver = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);

const resolvePstack = (fs, path, cursorDir) => {
  try {
    const base = path.join(cursorDir, 'plugins', 'cache', 'cursor-public', 'pstack');
    if (!fs.existsSync(base)) return { reason: 'pstack cache directory not found' };
    const candidates = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const manifestPath = path.join(dir, '.cursor-plugin', 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        if (fs.statSync(path.join(dir, '.cache-complete')).size !== 0) continue;
      } catch { continue; }
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (!manifest || manifest.name !== 'pstack') continue;
      candidates.push({ dir, version: String(manifest.version ?? '0.0.0'), mtime: fs.statSync(path.join(dir, '.cache-complete')).mtimeMs });
    }
    if (candidates.length === 0) return { reason: 'no completed pstack plugin directory in cache' };
    candidates.sort((a, b) => {
      const va = semver(a.version);
      const vb = semver(b.version);
      for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
      return b.mtime - a.mtime;
    });
    return { root: candidates[0].dir, version: candidates[0].version, skillsDir: path.join(candidates[0].dir, 'skills') };
  } catch (error) {
    return { reason: `resolution failed: ${String(error?.message ?? error)}` };
  }
};

const skillPath = (fs, path, resolved, name) => {
  if (!resolved?.skillsDir) return { reason: resolved?.reason ?? 'pstack not resolved' };
  const file = path.join(resolved.skillsDir, name, 'SKILL.md');
  try {
    if (!fs.statSync(file).isFile()) return { reason: `skill ${name}: not a file` };
    return { path: file };
  } catch {
    return { reason: `skill ${name}: missing` };
  }
};

const detectStage = (prompt) => {
  if (typeof prompt !== 'string') return { stage: null, reason: 'payload prompt is not a string' };
  const tokens = prompt.toLowerCase().match(/\/gsd-[a-z0-9-]+/g) ?? [];
  const stages = new Set();
  let matched = null;
  for (const token of tokens) {
    const command = token.slice(1);
    for (const [pattern, stage] of COMMAND_STAGE) {
      if (pattern.test(command)) {
        stages.add(stage);
        matched ??= command;
      }
    }
  }
  if (stages.size === 0) return { stage: null, reason: matched ? `unmapped gsd command ${matched}` : 'no gsd command in prompt' };
  if (stages.has('orchestrate')) return { stage: 'orchestrate', command: matched, router: ALL_STAGES };
  const stage = [...stages][0] ?? null;
  return { stage, command: matched };
};

const buildBlock = (fs, path, stage, resolved, mapping, cap) => {
  const stages = stage === 'orchestrate' ? ALL_STAGES : [stage];
  const entries = [];
  const dropped = [];
  for (const s of stages) {
    for (const name of mapping[s] ?? []) {
      const found = skillPath(fs, path, resolved, name);
      if (found.reason) {
        dropped.push(`${s}/${name}: ${found.reason}`);
        continue;
      }
      entries.push({ stage: s, name, path: found.path, purpose: PURPOSES[name] ?? `pstack ${name} skill` });
    }
  }
  if (entries.length === 0) {
    return { reason: `no resolvable skills${dropped.length ? ` (${dropped.join('; ')})` : ''}` };
  }
  const header = `pstack alongside GSD (${stage === 'orchestrate' ? 'orchestrate: apply each at its moment' : stage})`;
  const render = (list) => {
    const lines = [header, 'Run these pstack skills alongside the GSD step, by reading each SKILL.md, then continue the GSD workflow unchanged:'];
    for (const e of list) lines.push(`- [${e.stage}] ${e.name} — read ${e.path} — ${e.purpose} (${MOMENTS[e.stage]})`);
    if (dropped.length) lines.push(`- skipped: ${dropped.join('; ')}`);
    return lines.join('\n');
  };
  let list = entries;
  let block = render(list);
  while (block.length > cap && list.length > 1) {
    list = list.slice(0, -1);
    block = render(list) + `\n- (truncated by cap; ${entries.length - list.length} more skill(s) omitted)`;
  }
  if (block.length > cap) return { reason: `cap ${cap} too small for even one skill (needed ${block.length})` };
  return { block, skills: list.length };
};

// ---------- decision pipeline ----------

const readUserConfig = (fs, path) => {
  const home = process.env.HOME ?? '';
  // First file that exists and parses wins; there is no merge, and a project file is never read.
  // ULTRATHINK_CONFIG_DIR replaces the search. Otherwise the user file follows XDG_CONFIG_HOME
  // (else ~/.config) and the Claude user file follows CLAUDE_CONFIG_DIR (else ~/.claude).
  let candidates;
  if (process.env.ULTRATHINK_CONFIG_DIR) {
    candidates = [path.join(process.env.ULTRATHINK_CONFIG_DIR, 'config.json')];
  } else {
    const xdg = (process.env.XDG_CONFIG_HOME ?? '').trim();
    const claude = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
    candidates = [
      path.join(xdg || path.join(home, '.config'), 'ultrathink', 'config.json'),
      path.join(claude || path.join(home, '.claude'), 'ultrathink.json'),
    ];
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* unparseable or unreadable: fall through to the next candidate */ }
  }
  return null;
};

// A user mapping replaces a stage's list only when that stage's value is an array of strings.
const mappingFromConfig = (raw) => {
  const mapping = {
    discuss: [...DEFAULT_MAPPING.discuss],
    plan: [...DEFAULT_MAPPING.plan],
    execute: [...DEFAULT_MAPPING.execute],
    review: [...DEFAULT_MAPPING.review],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return mapping;
  for (const stage of ALL_STAGES) {
    const value = raw[stage];
    if (!Array.isArray(value)) continue;
    mapping[stage] = value.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim());
  }
  return mapping;
};

const decide = (raw, fs, path) => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return {}; }

  if (process.env.ULTRATHINK_PSTACK === '0') return {};

  const config = readUserConfig(fs, path);
  const pstack = config && typeof config === 'object' && !Array.isArray(config) ? config.pstack : null;
  if (!pstack || typeof pstack !== 'object' || Array.isArray(pstack) || pstack.enabled !== true) return {};

  const prompt = input && typeof input === 'object' && !Array.isArray(input) ? input.prompt : undefined;
  if (typeof prompt !== 'string') return {};

  const detected = detectStage(prompt);
  if (!detected || detected.stage === null) return {};

  const capRaw = pstack.contextCapChars;
  const cap = Number.isInteger(capRaw) && capRaw > 0 ? capRaw : 2000;

  const configuredDir = typeof pstack.cursorDir === 'string' && pstack.cursorDir.startsWith('/') ? pstack.cursorDir : '';
  const cursorDir = process.env.ULTRATHINK_PSTACK_CURSOR_DIR || configuredDir || path.join(process.env.HOME ?? '', '.cursor');
  const resolved = resolvePstack(fs, path, cursorDir);
  if (!resolved || typeof resolved.skillsDir !== 'string') return {};

  const built = buildBlock(fs, path, detected.stage, resolved, mappingFromConfig(pstack.mapping), cap);
  if (!built || typeof built.block !== 'string') return {};

  return { continue: true, additional_context: built.block };
};

const respond = (payload) => {
  process.exitCode = 0;
  process.stdout.write(JSON.stringify(payload), () => process.exit(0));
};

let raw = '';
const stdinTimeout = setTimeout(() => {
  respond({});
}, 10000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  // Dynamic import is the only module form legal both as CommonJS (staged in
  // ~/.cursor, no package.json) and as ESM (run in-repo with node, where the
  // repo root package.json sets "type": "module").
  Promise.all([import('node:fs'), import('node:path')])
    .then(([fs, path]) => {
      let payload;
      try { payload = decide(raw, fs, path); } catch { payload = {}; }
      respond(payload);
    })
    .catch(() => respond({}));
});
