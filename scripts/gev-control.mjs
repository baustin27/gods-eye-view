#!/usr/bin/env node
/**
 * gev-control.mjs — drive a RUNNING God's Eye View window from the shell.
 *
 * The app is a browser application, so nothing in it is reachable over its own
 * HTTP surface: the server exposes read-only upstream proxies and a hard 404
 * for anything else (server/standalone/api-not-found.js). Control therefore
 * rides the Chrome DevTools Protocol against the app's own frame.
 *
 * No model is involved. `window.__gevVoiceCommands.runner(name, args)`
 * (src/voice/gevActions.js) is a plain async function that the voice layer
 * merely calls — the LLM only decides WHICH action to call from speech. Driving
 * it directly skips the LLM, the WebRTC session, the microphone and the cost
 * cap, which is why this stays usable without OPENAI_API_KEY.
 *
 * This is the same surface scripts/qa-voice-routing.mjs drives in its
 * "LAYER 2 — no model" band, built for interactive use rather than assertions.
 *
 * Prerequisites:
 *   - the app served (npm run dev, or via Pinokio)
 *   - the window launched with --remote-debugging-port
 *       ~/.local/bin/pinokio-gpu  (or `google-chrome --remote-debugging-port=9333`)
 *   - the app open in that window
 *
 * Usage:
 *   node scripts/gev-control.mjs state
 *   node scripts/gev-control.mjs run <action> ['<jsonArgs>']
 *   node scripts/gev-control.mjs actions
 *   node scripts/gev-control.mjs eval '<expression>'
 *
 * Examples:
 *   node scripts/gev-control.mjs run fly_to_location '{"locationId":"austin"}'
 *   node scripts/gev-control.mjs run fly_to_location '{"query":"Wheat Ridge, CO"}'
 *   node scripts/gev-control.mjs run set_detection '{"mode":"DENSE"}'
 *
 * Env:
 *   GEV_CDP   DevTools endpoint (default http://127.0.0.1:9333)
 */

import WebSocket from 'ws';

const ENDPOINT = process.env.GEV_CDP || 'http://127.0.0.1:9333';
const APP_PATTERN = /127\.0\.0\.1:42003|localhost:42003/;

function fail(message, detail) {
  process.stderr.write(`gev-control: ${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

/**
 * Locate the app's frame target.
 *
 * Pinokio embeds the app in an out-of-process iframe inside its sidebar, so it
 * is never a top-level page target. Puppeteer's page.frames() cannot see
 * cross-process iframes either, which is why this speaks raw CDP.
 */
async function connect() {
  let targets;
  try {
    targets = await (await fetch(`${ENDPOINT}/json/list`)).json();
  } catch {
    fail(
      `no DevTools endpoint at ${ENDPOINT}`,
      'Launch the window with --remote-debugging-port=<port>, or set GEV_CDP.',
    );
  }

  const target = targets.find((t) => APP_PATTERN.test(t.url || ''));
  if (!target) {
    const seen = targets
      .filter((t) => t.type === 'page' || t.type === 'iframe')
      .map((t) => `  [${t.type}] ${t.url}`);
    fail('the app is not open in that window', seen.join('\n'));
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    origin: ENDPOINT,
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', () =>
      reject(
        new Error(
          `could not attach to ${target.webSocketDebuggerUrl}. If this is a ` +
            'newer Chromium, the caller may need --remote-allow-origins.',
        ),
      ),
    );
  });

  let nextId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };

  /** Evaluate in the app frame; awaits promises and unwraps by value. */
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = response.result?.exceptionDetails;
    if (details) {
      throw new Error(
        details.exception?.description || JSON.stringify(details),
      );
    }
    return response.result?.result?.value;
  };

  return { ws, evaluate };
}

/** Read-only snapshot of camera, renderer, and render governor. */
const READ_STATE = `(() => {
  const v = window.__godsEyeView.viewer;
  const p = v.camera.positionCartographic;
  const d = 180 / Math.PI;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({
    camera: {
      lon: +(p.longitude * d).toFixed(5),
      lat: +(p.latitude * d).toFixed(5),
      heightM: Math.round(p.height),
    },
    renderer: gl
      ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
      : 'none',
    governor: window.__godsEyeView.getRenderGovernorDiagnostics?.() ?? null,
  }, null, 2);
})()`;

/**
 * Action names and parameters, read from the module that owns them rather than
 * hardcoded here, so this list cannot drift from what the runner accepts.
 */
const ACTIONS_SOURCE = `import('/src/voice/actionSchemas.js')
  .then((m) => {
    const schemas = m.GEV_ACTION_SCHEMAS ?? m.default ?? [];
    const rows = schemas.map((s) => {
      const props = Object.keys(s?.parameters?.properties ?? {});
      return { action: s.name, params: props };
    });
    return JSON.stringify(rows, null, 2);
  })
  .catch((e) => 'could not read action schemas: ' + e.message)`;

const [command, ...rest] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/gev-control.mjs state',
      '  node scripts/gev-control.mjs run <action> [\x27<jsonArgs>\x27]',
      '  node scripts/gev-control.mjs actions',
      '  node scripts/gev-control.mjs eval \x27<expression>\x27',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const { ws, evaluate } = await connect();

try {
  const ready = await evaluate(
    '!!(window.__godsEyeView?.viewer && window.__gevVoiceCommands?.runner)',
  );
  if (!ready) fail('the app frame has not finished booting yet');

  if (command === 'state') {
    process.stdout.write(`${await evaluate(READ_STATE)}\n`);
  } else if (command === 'run') {
    const [action, argsJson] = rest;
    if (!action) fail('run needs an action name');
    const args = argsJson ? JSON.parse(argsJson) : {};
    const result = await evaluate(
      `window.__gevVoiceCommands.runner(${JSON.stringify(action)}, ${JSON.stringify(args)})`,
    );
    process.stdout.write(
      `${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`,
    );
  } else if (command === 'actions') {
    process.stdout.write(`${await evaluate(ACTIONS_SOURCE)}\n`);
  } else if (command === 'eval') {
    if (!rest.length) fail('eval needs an expression');
    const result = await evaluate(rest.join(' '));
    process.stdout.write(
      `${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`,
    );
  } else {
    fail(`unknown command ${command}`, 'Try: state, run, actions, eval');
  }
} catch (error) {
  fail('command failed', String(error?.message || error));
} finally {
  ws.close();
}
