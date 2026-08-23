# CodeBurn Repository Instructions

CodeBurn is an open-source Node.js CLI and dashboard for read-only AI usage and
cost visibility. The owned fork is distinct from the upstream repository.

- Preserve provider authentication, local usage databases, pricing overrides,
  account routing, and user-owned settings. Never log or commit credential or
  usage-record contents.
- Keep collection and reporting read-only unless the request explicitly names a
  local CodeBurn configuration change. Do not infer provider billing truth from
  incomplete local logs.
- Confirm whether a change targets the owned fork or upstream before publishing
  it. A fork merge is not an upstream release.
- Use the scripts in `package.json`. Run the narrowest relevant Vitest target,
  then `npm test` for shared parser or reporting changes. Use `npm run build:cli`
  when CLI bundling is affected.
- Before handoff, run `git diff --check` and `git status --porcelain`.
