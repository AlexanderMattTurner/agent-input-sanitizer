# llm-text-sanitizer

> [!NOTE]
> This repository was bootstrapped from the
> [Claude Automation Template](https://github.com/alexander-turner/claude-automation-template).
> The sections below describe the automation that ships with it. Replace this
> notice with a real project description as `llm-text-sanitizer` takes shape.

## Setup

```bash
git clone <your-repo-url>
cd llm-text-sanitizer
./setup.sh
```

This installs dependencies and configures git hooks. Verify the output ends with
`✓ Setup complete!`. Then install the
[Claude GitHub App](https://github.com/apps/claude) to enable `@claude` mentions
in issues and PRs.

When you start writing code, wire up the `dev`, `build`, `test`, `lint`, and
`check` scripts in `package.json` (and/or the Python tooling in
`pyproject.toml`). Unconfigured scripts are detected and skipped gracefully, so
nothing breaks before they exist.

## What's Included

### Git Hooks (`.hooks/`)

| Hook          | What it does                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `pre-commit`  | Runs lint-staged—auto-formats with Prettier, shfmt, and ruff by file type |
| `commit-msg`  | Validates [Conventional Commits](https://www.conventionalcommits.org/)    |
| `lint-skills` | Validates skill files have required frontmatter (`name`, `description`)    |

### Claude Session Hooks (`.claude/hooks/`)

| Hook           | What it does                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `SessionStart` | Installs tools (shfmt, shellcheck), configures git, installs dependencies |
| `PreToolUse`   | Runs build/lint/typecheck/tests before `git push` or `gh pr create`       |

### Claude Skills (`.claude/skills/`)

`pr-creation`, `update-pr`, `conventional-commits`, `markdown-block`,
`peer-review`, and `explore-plan`. See each skill's `SKILL.md` for details.

### Claude Subagents (`.claude/agents/`)

`code-reviewer` — a read-only reviewer (Read/Grep/Glob) for an unbiased second
opinion on a diff.

### GitHub Actions (`.github/workflows/`)

`claude.yaml` (responds to `@claude` mentions), `template-sync.yaml` (daily sync
from the template), `phone-home.yaml`, `security-vulnerability-scan.yaml`,
`node-tests.yaml`, `lint.yaml`, `format-check.yaml`, `pre-commit.yaml`,
`validate-config.yaml`, and `dependabot-auto-merge.yaml`.

## Automatic Template Updates

Template improvements sync daily at 9am UTC via `template-sync.yaml` (or trigger
manually from **Actions > Sync from Template**). Changes arrive as a PR using a
3-way merge that preserves local customizations. `.template-version` pins the
template commit this repo was synced from.

To enable cross-repo syncing, create a fine-grained personal access token with
`contents`, `workflows`, and `pull requests` read/write access, and add it as a
repository secret named `TEMPLATE_SYNC_TOKEN`.

For the full description of every component, see the
[template README](https://github.com/alexander-turner/claude-automation-template#readme).
