# AGENTS.md

**Read this before you start.** These are the standing rules for working in
this repository. They are not advice; they are the checkable ones.

---

## 1. Drain the registry

The work is registered in `scripts/task-registry.json`. Every task carries an
`id`, a `title`, the `files` it touches, a `gate` (how you know it is done) and
a `status` of `open` or `done`.

**Before you stop:**

1. Every task you were asked to do is `status: "done"`, with the commit that
   landed it in `commit`.
2. `npm run check:tasks` passes.
3. `npm test` is green.
4. `npm run build` succeeds.

If a task genuinely cannot be finished, it stays `open`, and you say so **in
your final message**, with the reason. You do not close it quietly.

**An open task that is not reported is the only failure this rule permits.**

The checker also fails a task that claims to be `done` but points at a file
that is not there — a task whose code has been renamed or deleted is not done,
whatever the registry says.

## 2. Do not stop halfway through a workstream

The work is registered in waves. **A wave is finished when every task in it is
`done`.** Do not stop halfway through a wave to report progress — finish the
wave, then report.

The exception is a task blocked on something outside the repository. It stays
`open` with the reason in its title, and you say so.

Reporting progress is not the job. **Finishing is the job.** A session that
stops at the end of wave 3 of 8 has delivered less than half of what was
asked, and the report is not a substitute.

## 3. Branches and pushes

Work lands on a branch and is committed per wave, not per file. **Do not
push** unless you are asked to. Nothing in this repository is pushed by
default, and that is deliberate.

## 4. Say what is true

- A number in a commit message or a report is a **measured** number unless it
  says otherwise. Measure it.
- If a change is not verified, say it is not verified.
- If something is broken, say it is broken, with the evidence.

An unverified claim is worth less than no claim, because it will be relied on.

## 5. The house style

- **The repo's own guards are the pattern.** `scripts/check-import-directions.mjs`
  is the template for a new check script: an exported pure function so it can
  be tested without a process, errors collected into a `Set` and thrown as one
  aggregate, and a CLI that prints JSON on success and the message to stderr
  with a non-zero exit on failure. Put a new check's test in
  `src/tooling/` — `npm test` discovers `*.test.mjs` under `src`, `server`,
  `scripts` and `apps`.
- **Comments explain WHY.** This repository's comments are long and they are
  about reasons, not about what the next line does. A comment that says what
  the code does is a comment the code already says. A comment that says *why
  it is like that* saves the next reader an hour.
- **Never trust a number that has not been round-tripped.** There is a
  precedent in this repo: `38.83 / 0.01` is `3882.9999999999995` in a
  double, so the floor of it put every point in the wrong grid row, moved
  every street in the country one cell off the hail, and produced an empty
  list with no error anywhere. The arithmetic was exact, and it was exactly
  wrong. All 4,405,145 hit cells now round-trip with zero mismatches, and
  there is a test that pins it.
- **`docs/KNOWN-ISSUES.md` is where the repo's own state lives.** Add an
  entry there rather than burying a caveat in a commit message.

## 6. Where things are

| | |
|---|---|
| `docs/PATH-B.md` | the Path B brief: the strategy and the competitive facts |
| `.opencode/plans/PATH-B-REGISTRY.md` | the wave-by-wave plan and what has landed |
| `.opencode/plans/PATH-B-GUARD.md` | how the guard is built and why |
| `scripts/task-registry.json` | the registered work |
| `docs/MAINTAINER-WORKFLOW.md` | the maintainer's checks and the review record |
| `docs/KNOWN-ISSUES.md` | what is known to be wrong |
| `scripts/run-unit-tests.mjs` | how `npm test` finds and runs the suites |
| `.github/workflows/ci.yml` | what CI runs |
