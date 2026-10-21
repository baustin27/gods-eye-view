import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkTaskCompletion } from '../../scripts/check-task-completion.mjs';

/**
 * A temporary repository with a registry in it.
 *
 * The checker reads the registry from the repository root and resolves each
 * task's files against it, so the test needs a real root - a temp directory
 * with a `scripts/` folder in it is enough.
 */
function repo(registry, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tasks-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'task-registry.json'),
    JSON.stringify(registry, null, 2),
  );
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return root;
}

const TASK = {
  id: 'X.1',
  title: 'a thing that needs doing',
  status: 'open',
  files: ['src/thing.js'],
  gate: 'the thing works',
};

test('an open task fails the check, and the message names it', () => {
  const root = repo({ version: 1, tasks: [TASK] }, { 'src/thing.js': '//' });
  assert.throws(
    () => checkTaskCompletion(root),
    (error) => {
      assert.match(error.message, /X\.1/);
      assert.match(error.message, /a thing that needs doing/);
      assert.match(error.message, /src\/thing\.js/);
      return true;
    },
  );
});

test('an open task is reported, not failed, when open work is allowed', () => {
  const root = repo({ version: 1, tasks: [TASK] }, { 'src/thing.js': '//' });
  const result = checkTaskCompletion(root, { allowOpen: true });
  assert.equal(result.tasks, 1);
  assert.equal(result.done, 0);
  assert.equal(result.open, 1);
  assert.equal(result.openTasks[0].id, 'X.1');
});

test('a done task with its file in place passes', () => {
  const root = repo(
    {
      version: 1,
      tasks: [{ ...TASK, status: 'done', commit: 'abc1234' }],
    },
    { 'src/thing.js': '//' },
  );
  const result = checkTaskCompletion(root);
  assert.equal(result.done, 1);
  assert.equal(result.open, 0);
});

test('a done task whose file is not there fails, because it is not done', () => {
  const root = repo({
    version: 1,
    tasks: [{ ...TASK, status: 'done', commit: 'abc1234' }],
  });
  assert.throws(
    () => checkTaskCompletion(root),
    /src\/thing\.js is not there/,
  );
});

test('a done task that names no commit fails', () => {
  const root = repo(
    { version: 1, tasks: [{ ...TASK, status: 'done' }] },
    { 'src/thing.js': '//' },
  );
  assert.throws(() => checkTaskCompletion(root), /names no commit/);
});

test('a task with no gate fails, because a task with no gate cannot be checked', () => {
  const root = repo(
    { version: 1, tasks: [{ ...TASK, gate: '' }] },
    { 'src/thing.js': '//' },
  );
  assert.throws(() => checkTaskCompletion(root, { allowOpen: true }), /no gate/);
});

test('a task with an unknown status fails', () => {
  const root = repo(
    { version: 1, tasks: [{ ...TASK, status: 'maybe' }] },
    { 'src/thing.js': '//' },
  );
  assert.throws(() => checkTaskCompletion(root, { allowOpen: true }), /is not one of/);
});

test('a duplicated id fails', () => {
  const root = repo(
    { version: 1, tasks: [TASK, { ...TASK }] },
    { 'src/thing.js': '//' },
  );
  assert.throws(() => checkTaskCompletion(root, { allowOpen: true }), /used more than once/);
});

test('the repository registry is well formed', () => {
  // The REAL registry, not a fixture. A registry that quietly loses its
  // statuses, its gates or its ids is a registry that stops guarding
  // anything, and nothing else would notice.
  const root = path.resolve(import.meta.dirname, '..', '..');
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'scripts', 'task-registry.json'), 'utf8'),
  );
  assert.ok(Array.isArray(registry.tasks), 'the registry has a tasks array');
  assert.ok(registry.tasks.length > 0, 'and it is not empty');
  const ids = new Set();
  for (const task of registry.tasks) {
    assert.ok(task.id, 'a task has an id');
    assert.ok(!ids.has(task.id), `the id ${task.id} is used once`);
    ids.add(task.id);
    assert.ok(task.title, `${task.id} has a title`);
    assert.ok(['open', 'done'].includes(task.status), `${task.id} has a status`);
    assert.ok(Array.isArray(task.files) && task.files.length, `${task.id} has files`);
    assert.ok(task.gate, `${task.id} has a gate`);
    if (task.status === 'done') assert.ok(task.commit, `${task.id} names its commit`);
    else assert.ok(!task.commit, `${task.id} is open, so it names no commit yet`);
  }
});
