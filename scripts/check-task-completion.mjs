#!/usr/bin/env node
/**
 * check-task-completion.mjs — the registered work, and whether it is finished.
 *
 * The problem this exists for: a long piece of work gets done in waves, and
 * the session that starts it can run out of attention, or context, or
 * patience, and stop halfway. The failure is not that the work is wrong. It
 * is that the work is SILENTLY incomplete - the agent reports what it did,
 * and the list of what it did not do is somewhere else, in prose, where
 * nobody reads it.
 *
 * So the list is a FILE, and this checks it. A task that is not done is a
 * failed check, not a judgement call, and the check runs in CI.
 *
 * Built on the shape of `check-import-directions.mjs`, deliberately: an
 * exported pure function so it can be tested without a process, errors
 * collected into a Set and thrown as one aggregate, and a CLI that prints
 * JSON on success and the message on stderr with a non-zero exit on failure.
 *
 * Usage:
 *   node scripts/check-task-completion.mjs              # strict: any open task fails
 *   node scripts/check-task-completion.mjs --allow-open # report the open tasks, exit 0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'scripts/task-registry.json';

/** The status vocabulary. `docs/KNOWN-ISSUES.md` uses prose; this is terser. */
const STATUSES = new Set(['open', 'done']);

/**
 * Every file the repository knows about, tracked or not.
 *
 * The same enumeration `check-import-directions.mjs` uses, so a task's file
 * is found whether it has been committed yet or not.
 *
 * @param {string} root
 * @returns {Set<string>}
 */
function repositoryFiles(root) {
  let out = '';
  try {
    out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    // Not a git repository, or git is not available. The check still works:
    // it just cannot tell a missing file from an untracked one.
    return new Set();
  }
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Check the registry.
 *
 * @param {string} root the repository root
 * @param {object} [options]
 * @param {boolean} [options.allowOpen] report open tasks instead of failing
 * @returns {{tasks: number, done: number, open: number, openTasks: Array<object>}}
 */
export function checkTaskCompletion(root, { allowOpen = false } = {}) {
  const errors = new Set();
  const registryPath = path.join(root, REGISTRY);
  if (!fs.existsSync(registryPath)) {
    throw new Error(`${REGISTRY} is missing`);
  }
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (error) {
    throw new Error(`${REGISTRY} is not valid JSON: ${error.message}`);
  }
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : null;
  if (!tasks) throw new Error(`${REGISTRY} has no "tasks" array`);

  const known = repositoryFiles(root);
  const seenIds = new Set();
  const openTasks = [];
  let done = 0;

  for (const task of tasks) {
    const id = String(task?.id || '').trim();
    if (!id) {
      errors.add('a task has no id');
      continue;
    }
    if (seenIds.has(id)) {
      errors.add(`${id}: the id is used more than once`);
      continue;
    }
    seenIds.add(id);
    const title = String(task?.title || '').trim();
    if (!title) errors.add(`${id}: no title`);
    const status = String(task?.status || '').trim();
    if (!STATUSES.has(status)) {
      errors.add(`${id}: status "${status}" is not one of ${[...STATUSES].join(', ')}`);
      continue;
    }
    const files = Array.isArray(task?.files) ? task.files.filter(Boolean) : [];
    if (!files.length) errors.add(`${id}: no files`);
    const gate = String(task?.gate || '').trim();
    if (!gate) errors.add(`${id}: no gate - a task with no gate cannot be checked`);

    if (status === 'open') {
      openTasks.push({ id, title, files, gate });
      if (!allowOpen) {
        errors.add(
          `${id}: ${title} — not done. Files: ${files.join(', ') || '(none)'}. ` +
            `Gate: ${gate || '(none)'}`,
        );
      }
      continue;
    }

    done += 1;
    const commit = String(task?.commit || '').trim();
    if (!commit) {
      errors.add(`${id}: done, but it names no commit`);
    }
    for (const file of files) {
      if (!fs.existsSync(path.join(root, file))) {
        errors.add(
          `${id}: done, but ${file} is not there. A task that points at a file ` +
            'that has been renamed or deleted is not done.',
        );
      } else if (known.size && !known.has(file)) {
        errors.add(`${id}: done, but ${file} is not a repository file`);
      }
    }
  }

  if (errors.size) {
    throw new Error([...errors].join('\n'));
  }
  return { tasks: tasks.length, done, open: openTasks.length, openTasks };
}

// The CLI. The self-invocation guard is the house pattern.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const allowOpen = process.argv.includes('--allow-open');
  const root = process.cwd();
  try {
    const result = checkTaskCompletion(root, { allowOpen });
    console.log(JSON.stringify(result, null, 2));
    if (allowOpen && result.open) {
      console.error(
        `\n${result.open} task(s) are still open:` +
          result.openTasks.map((task) => `\n  ${task.id}: ${task.title}`).join(''),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
