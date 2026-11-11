import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const shell = await readFile(new URL('../shell.html', import.meta.url), 'utf8');
const inlineScript = shell.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'shell must contain its inline frontend script');

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.parentNode = null;
    this.style = {};
    this.open = false;
    const classes = new Set();
    this.classList = {
      add: (name) => { classes.add(name); },
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; },
    };
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) {
      callback({ ...event, currentTarget: this, target: event.target || this });
    }
  }

  moveChildren(nodes, prepend) {
    for (const node of nodes) {
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      }
      node.parentNode = this;
    }
    this.children = prepend ? [...nodes, ...this.children] : [...this.children, ...nodes];
  }

  append(...nodes) { this.moveChildren(nodes, false); }
  insertBefore(node) { this.moveChildren([node], false); }
  prepend(...nodes) { this.moveChildren(nodes, true); }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    return selector === 'h2' ? this.heading : null;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  select() {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(text) { this.sent.push(text); }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const workingGpu = {
  requestAdapter: async () => ({ info: { vendor: 'test' }, limits: {}, features: new Set() }),
};

// By default the page is served next to a staged game folder (tools/stage-web.sh), so it plays
// that and asks for no disc image; the disc tests at the end serve no game folder.
const stagedManifest = 'd DATA\nf 10 DATA/sys/fst.bin\nf 1088 DATA/sys/boot.bin\n';
const siteFetch = (files, requests = []) => async (url, options = {}) => {
  requests.push([options.method || 'GET', url]);
  if (!(url in files)) return { ok: false, status: 404, arrayBuffer: async () => new TextEncoder().encode('Not found').buffer };
  return { ok: true, arrayBuffer: async () => new TextEncoder().encode(files[url]).buffer };
};
const stagedSiteFetch = siteFetch({ 'game/manifest-v2.txt': stagedManifest, 'game/DATA/sys/boot.bin': '' });
const noGameFolderFetch = siteFetch({});

function setupRoomPage(search = '?room=abcdef', navigatorOverride = { gpu: workingGpu, userAgent: 'test' }, pageOverride = {}) {
  const ids = [
    'room-message', 'room-panel', 'room-name', 'room-connection', 'room-roster', 'room-count',
    'room-game-status', 'cancel-room-launch', 'lobby-card', 'room-setup', 'room-invite',
    'invite-link', 'join-room', 'create-room', 'copy-invite', 'leave-room', 'status', 'start',
    'reload', 'overlay', 'controls', 'stage', 'dock', 'dock-toggle', 'dock-controls', 'dock-saves', 'dock-room', 'dock-help',
    'dock-room-count', 'fullscreen-toggle',
    'canvas', 'volume',
    'volume-value', 'toggle-mute', 'keyboard-off', 'binding-help', 'room-code',
    'hint', 'diag', 'diag-text', 'diag-copy', 'game-runtime', 'save-status', 'save-log', 'diag-save-log', 'detailed-log',
    'disc-panel', 'disc-status', 'disc-pick', 'disc-reuse', 'disc-file', 'disc-clear',
    // The menu shown before the game starts.
    'menu', 'menu-nav', 'nav-solo', 'nav-friends', 'nav-controls', 'nav-saves', 'nav-solo-desc',
    'nav-friends-desc', 'disc-chip', 'disc-chip-text', 'change-disc', 'open-problems', 'foot-help', 'menu-back',
    'problems-dialog', 'disc-invite', 'disc-back', 'solo-disc', 'start-slot-solo', 'start-slot-friends',
    'room-reload-note', 'foot-desc', 'foot-load', 'load-label', 'load-bar', 'load-fill', 'load-pct',
    'bindings-block', 'saves-panel', 'problems-block',
  ];
  const elements = new Map(ids.map((id) => [id, new Element(id)]));
  elements.get('start').disabled = true;
  elements.get('diag').hidden = true;
  elements.get('save-status').hidden = true;
  elements.get('disc-panel').hidden = true;
  elements.get('disc-reuse').hidden = true;
  elements.get('game-runtime').content = { querySelectorAll: () => [{
    attributes: [{ name: 'src', value: 'WiiCompiled.js' }, { name: 'async', value: '' }], textContent: '',
  }] };
  const roomPanel = elements.get('room-panel');
  roomPanel.heading = new Element('room-heading');
  roomPanel.children = [roomPanel.heading];
  roomPanel.heading.parentNode = roomPanel;
  const body = new Element('body');
  // As in the markup: the room panel starts in the menu's Play with friends panel, Start in Solo.
  elements.get('lobby-card').append(roomPanel);
  elements.get('start-slot-solo').append(elements.get('start'));
  elements.get('overlay').append(elements.get('menu'), elements.get('hint'));
  elements.get('foot-load').append(elements.get('status'));
  elements.get('disc-back').hidden = true;
  body.classList.add('pregame');
  elements.get('room-name').value = 'Racer';
  const roomsHostMeta = { content: 'rooms.example.test' };
  const document = {
    body,
    activeElement: null,
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => selector === 'meta[name="mkw-rooms-host"]' ? roomsHostMeta : null,
    querySelectorAll: () => [],
  };
  const localValues = new Map();
  localValues.set('mkw-room-name', 'Racer');
  const localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, value),
  };
  const timers = new Set();
  FakeWebSocket.instances = [];
  const window = { addEventListener() {} };
  const location = new URL(`https://game.test/${search}`);
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Blob,
    TextDecoder,
    AbortSignal,
    WebSocket: FakeWebSocket,
    document,
    location: { href: location.href, hostname: location.hostname, search: location.search },
    window,
    navigator: navigatorOverride,
    self: { crossOriginIsolated: true, isSecureContext: true },
    WebAssembly: { Suspending() {}, promising() {} },
    localStorage,
    ENV: {},
    console,
    setTimeout: () => { const timer = {}; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    setInterval: () => 0,
    Image: class { set src(value) { this.source = value; } },
    addEventListener() {},
    fetch: stagedSiteFetch,
    crypto: { randomUUID: () => '0123abcd-0000-4000-8000-000000000000' },
    ...pageOverride,
  });
  vm.runInContext(inlineScript, context, { filename: 'shell.html inline script' });
  return { context, elements, localValues, sockets: FakeWebSocket.instances, timers, window, body };
}

function welcome(socket) {
  socket.message({ type: 'welcome', token: 'a'.repeat(32), id: 7 });
}

test('an early lobby open and name edit use the socket without calling the Wasm export', () => {
  const { context, elements, localValues, sockets, window } = setupRoomPage();
  const module = context.Module;
  let nativeCalls = 0;
  module._mkw_web_room_name = () => {
    assert.equal(vm.runInContext('runtimeReady', context), true, 'Wasm export called before runtime readiness');
    nativeCalls++;
  };

  const socket = sockets[0];
  assert.ok(socket, 'room invite should connect immediately');
  assert.doesNotThrow(() => socket.open());
  assert.deepEqual(socket.sent.map(JSON.parse), [{ type: 'name', name: 'Racer' }]);

  const name = elements.get('room-name');
  name.value = '  Guest Name  ';
  assert.doesNotThrow(() => name.dispatch('input'));
  assert.equal(window.mkwRoomName, 'Guest Name');
  assert.equal(localValues.get('mkw-room-name'), 'Guest Name');
  assert.deepEqual(socket.sent.map(JSON.parse), [
    { type: 'name', name: 'Racer' },
    { type: 'name', name: 'Guest Name' },
  ]);
  assert.equal(nativeCalls, 0);

  module.onRuntimeInitialized();
  name.dispatch('change');
  assert.equal(nativeCalls, 1, 'room name should notify Wasm after initialization');
});

test('Play stays disabled until both lobby welcome and runtime readiness, in either order', () => {
  for (const readyFirst of ['runtime', 'lobby']) {
    const { context, elements, sockets } = setupRoomPage();
    const start = elements.get('start');
    const socket = sockets[0];
    socket.open();
    assert.equal(start.disabled, true, readyFirst);
    if (readyFirst === 'runtime') {
      context.Module.onRuntimeInitialized();
      assert.equal(start.disabled, true, 'runtime alone must not enable Play');
      welcome(socket);
    } else {
      welcome(socket);
      assert.equal(start.disabled, true, 'lobby welcome alone must not enable Play');
      context.Module.onRuntimeInitialized();
    }
    assert.equal(start.disabled, false, readyFirst);
    assert.equal(start.textContent, 'Play online');
  }
});

test('manual Play is single-shot and reveals the game immediately', () => {
  const { context, elements, sockets } = setupRoomPage('?room=abcdef&manual');
  const start = elements.get('start');
  const socket = sockets[0];
  const controls = elements.get('controls');
  const roomPanel = elements.get('room-panel');
  const lobbyCard = elements.get('lobby-card');
  const calls = [];
  context.Module.callMain = (args) => calls.push(args);

  socket.open();
  welcome(socket);
  context.Module.onRuntimeInitialized();
  assert.equal(start.disabled, false);
  assert.equal(roomPanel.parentNode, lobbyCard);

  start.dispatch('click');
  start.dispatch('click');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 0);
  assert.equal(roomPanel.parentNode, controls);
  assert.equal(controls.children[0], roomPanel);
  assert.equal(lobbyCard.children.includes(roomPanel), false);
  assert.equal(elements.get('overlay').hidden, true);
  for (const id of ['create-room', 'join-room', 'room-code']) {
    assert.equal(elements.get(id).disabled, true, `${id} should be disabled after starting`);
  }
});

test('direct Play keeps the lobby overlay until the runtime reports ready', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const start = elements.get('start');
  const socket = sockets[0];
  const controls = elements.get('controls');
  const roomPanel = elements.get('room-panel');
  const lobbyCard = elements.get('lobby-card');
  const overlay = elements.get('overlay');
  const cancel = elements.get('cancel-room-launch');
  const calls = [];
  module.callMain = (args) => calls.push(args);

  socket.open();
  welcome(socket);
  module.onRuntimeInitialized();
  module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_DIRECT_JOIN, '1');
  assert.equal(context.ENV.MKW_WEB_AUTO_JOIN, undefined, 'the old macro flag is removed');
  assert.equal(context.ENV.MKW_WEB_ROOM.includes('/v1/rooms/abcdef/ws'), true);

  start.dispatch('click');
  start.dispatch('click');

  assert.equal(calls.length, 1, 'direct Play must start the game once');
  assert.equal(overlay.hidden, false, 'the overlay remains while the direct room connection initializes');
  assert.equal(roomPanel.parentNode, lobbyCard, 'the lobby stays visible in the overlay');
  assert.equal(start.hidden, true);
  assert.equal(start.disabled, true);
  assert.equal(cancel.hidden, false);
  assert.equal(elements.get('status').textContent, 'Starting a direct connection to your room…');

  context.window.mkwSetRoomLaunchStatus('Connecting directly to your room…', 'loading');
  assert.equal(overlay.hidden, false);
  assert.equal(cancel.hidden, false);
  assert.equal(elements.get('status').textContent, 'Connecting directly to your room…');

  context.window.mkwSetRoomLaunchStatus('Character and vehicle selection is ready.', 'ready');
  assert.equal(overlay.hidden, true);
  assert.equal(roomPanel.parentNode, controls);
  assert.equal(cancel.hidden, true);
  assert.equal(elements.get('canvas').focused, true);
  assert.equal(elements.get('room-game-status').textContent, 'Character and vehicle selection is ready.');
  context.window.mkwSetRoomLaunchStatus('Late loading update.', 'loading');
  assert.equal(overlay.hidden, true, 'late loading updates must not reopen a settled launch');
});

test('direct launch accepts a runtime manual handoff and Cancel invokes the export once', () => {
  for (const cancelFromUi of [false, true]) {
    const { context, elements, sockets } = setupRoomPage();
    const module = context.Module;
    const start = elements.get('start');
    const socket = sockets[0];
    const controls = elements.get('controls');
    const roomPanel = elements.get('room-panel');
    const overlay = elements.get('overlay');
    const cancel = elements.get('cancel-room-launch');
    const calls = [];
    let cancelCalls = 0;
    module.callMain = (args) => calls.push(args);
    module._mkw_web_cancel_room_launch = () => { cancelCalls++; };

    socket.open();
    welcome(socket);
    module.onRuntimeInitialized();
    start.dispatch('click');
    assert.equal(calls.length, 1);
    assert.equal(overlay.hidden, false);

    if (cancelFromUi) {
      cancel.dispatch('click');
      cancel.dispatch('click');
      assert.equal(cancelCalls, 1, 'the cancel export is called once');
      assert.match(elements.get('room-game-status').textContent, /manually/);
    } else {
      context.window.mkwSetRoomLaunchStatus('Continue through the menus.', 'manual');
      assert.equal(cancelCalls, 0);
    }

    assert.equal(overlay.hidden, true);
    assert.equal(roomPanel.parentNode, controls);
    assert.equal(cancel.hidden, true);
    assert.equal(elements.get('canvas').focused, true);
    context.window.mkwSetRoomLaunchStatus('Late loading update.', 'loading');
    assert.equal(overlay.hidden, true, 'manual handoff must stay settled');
  }
});

test('a failed direct launch keeps its error and Reload visible against late status updates', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const socket = sockets[0];
  const calls = [];
  module.callMain = (args) => calls.push(args);
  socket.open();
  welcome(socket);
  module.onRuntimeInitialized();
  elements.get('start').dispatch('click');

  context.window.mkwSetRoomLaunchStatus('The room connection failed.', 'failed');
  assert.equal(elements.get('overlay').hidden, false);
  assert.equal(elements.get('room-panel').parentNode, elements.get('lobby-card'));
  assert.equal(elements.get('status').textContent, 'The room connection failed.');
  assert.equal(elements.get('reload').hidden, false);
  assert.equal(elements.get('start').hidden, true);
  assert.equal(elements.get('cancel-room-launch').hidden, true);

  context.window.mkwSetRoomLaunchStatus('Late success.', 'ready');
  module.setStatus('late download status');
  assert.equal(elements.get('overlay').hidden, false);
  assert.equal(elements.get('status').textContent, 'The room connection failed.');
  assert.equal(elements.get('reload').hidden, false);
  assert.equal(calls.length, 1);
});

test('manual invite and no-room Start keep the normal immediate reveal', () => {
  for (const search of ['?room=abcdef&manual', '?']) {
    const { context, elements, sockets } = setupRoomPage(search);
    const module = context.Module;
    const start = elements.get('start');
    const controls = elements.get('controls');
    const roomPanel = elements.get('room-panel');
    const calls = [];
    module.callMain = (args) => calls.push(args);

    if (sockets[0]) {
      sockets[0].open();
      welcome(sockets[0]);
    }
    module.onRuntimeInitialized();
    module.preRun[0]();
    assert.equal(context.ENV.MKW_WEB_DIRECT_JOIN, undefined);
    assert.equal(context.ENV.MKW_WEB_AUTO_JOIN, undefined);
    start.dispatch('click');

    assert.equal(calls.length, 1);
    assert.equal(elements.get('overlay').hidden, true);
    assert.equal(roomPanel.parentNode, controls);
    assert.equal(elements.get('cancel-room-launch').hidden, true);
  }
});

test('copied room invites omit the manual opt-out flag', () => {
  const { elements } = setupRoomPage('?room=abcdef&manual');
  const invite = new URL(elements.get('invite-link').value);
  assert.equal(invite.searchParams.get('room'), 'abcdef');
  assert.equal(invite.searchParams.has('manual'), false);
});

test('an abort remains fatal when late download and readiness callbacks arrive', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const status = elements.get('status');
  const start = elements.get('start');
  const overlay = elements.get('overlay');
  const reload = elements.get('reload');
  const calls = [];
  module.callMain = (args) => calls.push(args);

  module.onAbort('test failure');
  const fatalMessage = 'The game stopped: test failure (details in the browser console).';
  assert.equal(status.textContent, fatalMessage);
  assert.equal(overlay.hidden, false);
  assert.equal(start.hidden, true);
  assert.equal(reload.hidden, false);

  module.setStatus('Downloading data (1/5)');
  module.onRuntimeInitialized();
  const socket = sockets[0];
  socket.open();
  welcome(socket);

  assert.equal(status.textContent, fatalMessage);
  assert.equal(reload.hidden, false);
  assert.equal(start.hidden, true);
  assert.equal(start.disabled, true);
  assert.equal(vm.runInContext('runtimeFailed', context), true);
  assert.equal(vm.runInContext('runtimeReady', context), false);

  start.dispatch('click');
  assert.equal(calls.length, 0, 'fatal runtime state must never enter the game');
  context.window.mkwSetRoomLaunchStatus('Late direct ready.', 'ready');
  assert.equal(status.textContent, fatalMessage, 'a late room callback must not clear a fatal abort');
  assert.equal(reload.hidden, false);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('WebGPU without a graphics adapter is explained before Start and cannot be started', async () => {
  const gpu = { requestAdapter: async () => null };
  const { context, elements } = setupRoomPage('', { gpu, userAgent: 'Mozilla/5.0 Chrome/150.0 Safari/537.36' });
  await settle();
  const module = vm.runInContext('Module', context);
  module.onRuntimeInitialized();

  const start = elements.get('start');
  assert.equal(start.hidden, true, 'a finished runtime load must not bring the Start button back');
  assert.match(elements.get('status').textContent, /missing: a usable WebGPU graphics adapter/);
  assert.match(elements.get('hint').textContent, /Hardware acceleration/);
  assert.equal(elements.get('hint').hidden, false);
  assert.equal(elements.get('diag').hidden, false);
  assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): no adapter/);
  assert.match(elements.get('diag-text').textContent, /User agent: .*Chrome\/150/);
});

test('a browser without the WebGPU API gets advice for its own family', async () => {
  const firefox = setupRoomPage('', { userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/156.0' });
  await settle();
  assert.match(firefox.elements.get('status').textContent, /missing: WebGPU\./);
  assert.match(firefox.elements.get('hint').textContent, /Firefox only turns WebGPU on/);

  const iphone = setupRoomPage('', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) CriOS/150 Mobile Safari/604.1' });
  await settle();
  assert.match(iphone.elements.get('hint').textContent, /Safari 27/);
});

test('a working adapter leaves the page alone', async () => {
  const { context, elements } = setupRoomPage();
  await settle();
  assert.doesNotMatch(elements.get('status').textContent, /missing/);
  assert.equal(elements.get('diag-text').textContent, '', 'no diagnostics are shown when nothing failed');
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('a browser-default adapter can start when high-performance selection returns nothing', async () => {
  const attempts = [];
  const { context, elements, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async (options) => {
      attempts.push(options.powerPreference || 'default');
      return options.powerPreference ? null : workingGpu.requestAdapter();
    } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.deepEqual(attempts, ['high-performance', 'default']);
  assert.equal(vm.runInContext('runtimeFailed', context), false);
  assert.doesNotMatch(elements.get('status').textContent, /missing/);
  assert.equal(body.children.length, 1, 'the loader must start after a successful fallback');
  assert.equal(body.children[0].attributes.get('src'), 'WiiCompiled.js');
});

test('low-power selection can recover after a thrown preferred request and a null default', async () => {
  const attempts = [];
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async (options) => {
      attempts.push(options.powerPreference || 'default');
      if (options.powerPreference === 'high-performance') throw new Error('preferred adapter unavailable');
      return options.powerPreference === 'low-power' ? workingGpu.requestAdapter() : null;
    } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.deepEqual(attempts, ['high-performance', 'default', 'low-power']);
  assert.equal(body.children.length, 1);
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('the normal high-performance path does not request additional adapters', async () => {
  let calls = 0;
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async () => { calls++; return workingGpu.requestAdapter(); } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.equal(calls, 1);
  assert.equal(body.children.length, 1);
});

test('missing JSPI or adapters never load the heavyweight game runtime', async () => {
  for (const [navigatorOverride, pageOverride] of [
    [{ gpu: workingGpu, userAgent: 'test' }, { WebAssembly: {} }],
    [{ gpu: { requestAdapter: async () => null }, userAgent: 'test' }, {}],
    [{ userAgent: 'test' }, {}],
  ]) {
    const { context, body } = setupRoomPage('', navigatorOverride, pageOverride);
    await vm.runInContext('loadRuntime()', context);
    assert.equal(body.children.length, 0);
  }
});

test('the runtime loader waits for the asynchronous GPU probe', async () => {
  let resolveAdapter;
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: () => new Promise((resolve) => { resolveAdapter = resolve; }) },
  });
  const loading = vm.runInContext('loadRuntime()', context);
  await settle();
  assert.equal(body.children.length, 0);
  resolveAdapter(await workingGpu.requestAdapter());
  await loading;
  assert.equal(body.children.length, 1);
});

test('a failed loader download displays an actionable abort instead of staying on Loading', async () => {
  const { context, elements, body } = setupRoomPage('');
  await vm.runInContext('loadRuntime()', context);
  body.children[0].dispatch('error');
  assert.match(elements.get('status').textContent, /The game loader could not be downloaded/);
  assert.equal(elements.get('start').hidden, true);
});

test('denied persistent saving still loads the game and selects session-only storage', async () => {
  const { context, elements, body } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: {
      getDirectory: async () => { throw new Error('Storage access denied'); },
    },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.equal(body.children.length, 1);
  assert.equal(elements.get('save-status').hidden, false);
  assert.match(elements.get('save-status').textContent, /reload or close this page/);
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, '1');
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('available persistent saving does not switch to session-only storage', async () => {
  const { context, elements } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: { getDirectory: async () => ({}) },
  });
  await vm.runInContext('loadRuntime()', context);
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, undefined);
  assert.equal(elements.get('save-status').hidden, true);
});

test('an absent saving API warns about temporary progress without blocking the loader', async () => {
  const { context, elements, body } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' });
  await vm.runInContext('loadRuntime()', context);
  context.Module.preRun[0]();
  assert.equal(body.children.length, 1);
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, '1');
  assert.equal(elements.get('save-status').hidden, false);
});

test('the loader waits for the saving probe before publishing its storage choice', async () => {
  let resolveStorage;
  const { context, body } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: {
      getDirectory: () => new Promise((resolve) => { resolveStorage = resolve; }),
    },
  });
  const loading = vm.runInContext('loadRuntime()', context);
  await settle();
  assert.equal(body.children.length, 0);
  resolveStorage({});
  await loading;
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, undefined);
  assert.equal(body.children.length, 1);
});

test('binding guidance describes the actual session-only or persistent saving mode', async () => {
  for (const persistent of [false, true]) {
    const { context, elements } = setupRoomPage('', {
      gpu: workingGpu, userAgent: 'test',
      storage: persistent ? { getDirectory: async () => ({}) } : undefined,
    });
    await vm.runInContext('loadRuntime()', context);
    context.window.mkwSetBindings(JSON.stringify({ keyboard: true, editing: false, muted: false }));
    assert.match(elements.get('binding-help').textContent,
      persistent ? /saved in this browser/ : /reload or close this page/);
  }
});

test('missing JSPI and adapter show both remedies without claiming acceleration is off', async () => {
  const { context, elements } = setupRoomPage('', {
    gpu: { requestAdapter: async () => null },
    userAgent: 'Mozilla/5.0 Chrome/150.0 Safari/537.36',
  }, { WebAssembly: {} });
  await settle();
  const hint = elements.get('hint').textContent;
  assert.match(elements.get('status').textContent, /WebAssembly JSPI, a usable WebGPU graphics adapter/);
  assert.match(hint, /WebAssembly JSPI is unavailable/);
  assert.match(hint, /fully quit and reopen/);
  assert.match(hint, /WebGPU found no usable graphics adapter/);
  assert.match(hint, /Hardware acceleration being enabled does not guarantee/);
  assert.match(hint, /chrome:\/\/gpu/);
  assert.doesNotMatch(elements.get('status').textContent, /hardware acceleration/);
  context.Module.onRuntimeInitialized();
  assert.equal(elements.get('start').hidden, true);
});

test('JSPI needs both callable APIs, including when an older flag exposes only one', async () => {
  for (const wasm of [{ Suspending() {} }, { promising() {} }, { Suspending: undefined, promising() {} }]) {
    const { elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, { WebAssembly: wasm });
    await settle();
    assert.match(elements.get('status').textContent, /missing: WebAssembly JSPI\./);
    assert.match(elements.get('diag-text').textContent, /WebAssembly JSPI: false/);
    assert.match(elements.get('hint').textContent, /A flag cannot add support/);
  }
});

test('successful asynchronous GPU details are included in an already visible JSPI report', async () => {
  const { elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, { WebAssembly: {} });
  await settle();
  assert.match(elements.get('diag-text').textContent, /Adapter: test/);
  assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): adapter available/);
  assert.match(elements.get('diag-text').textContent, /WebAssembly.promising: undefined/);
});

test('a present but unusable gpu property reports a missing API without crashing the page', async () => {
  for (const gpu of [undefined, null, {}]) {
    const { elements } = setupRoomPage('', { gpu, userAgent: 'test' });
    await settle();
    assert.match(elements.get('status').textContent, /missing: WebGPU\./);
    assert.equal(elements.get('start').hidden, true);
  }
});

test('adapter request errors retain their reason and use the browser-specific diagnostics page', async () => {
  for (const [userAgent, diagnosticPage] of [
    ['Mozilla/5.0 Chrome/150 Safari/537.36 Edg/150', 'edge://gpu'],
    ['Mozilla/5.0 Firefox/156.0', 'about:support (Graphics)'],
  ]) {
    const { elements } = setupRoomPage('', {
      gpu: { requestAdapter: async () => { throw new Error('driver rejected request'); } }, userAgent,
    });
    await settle();
    assert.ok(elements.get('hint').textContent.includes(diagnosticPage));
    assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\) threw: Error: driver rejected request/);
    assert.doesNotMatch(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): no adapter/);
  }
});

test('a rejected clipboard promise gives a manual copy instruction', async () => {
  const { elements } = setupRoomPage('', {
    userAgent: 'test', clipboard: { writeText: async () => { throw new Error('permission denied'); } },
  });
  elements.get('diag-copy').dispatch('click');
  await settle();
  assert.match(elements.get('diag-copy').textContent, /Select the technical details/);
});

test('copy includes the completed GPU probe and confirms success', async () => {
  let copied;
  const { elements } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', clipboard: { writeText: async (text) => { copied = text; } },
  }, { WebAssembly: {} });
  await settle();
  elements.get('diag-copy').dispatch('click');
  await settle();
  assert.match(copied, /Adapter: test/);
  assert.equal(elements.get('diag-copy').textContent, 'Copied');
});

test('insecure and unisolated pages show their connection remedies alongside JSPI advice', async () => {
  const { elements } = setupRoomPage('', { userAgent: 'test' }, {
    WebAssembly: {}, self: { crossOriginIsolated: false, isSecureContext: false },
  });
  await settle();
  const hint = elements.get('hint').textContent;
  assert.match(hint, /WebAssembly JSPI is unavailable/);
  assert.match(hint, /HTTPS link/);
  assert.match(hint, /isolation headers/);
  assert.match(elements.get('diag-text').textContent, /Secure context: false/);
});

test('running out of memory while loading explains itself and keeps the details', () => {
  const { context, elements } = setupRoomPage('');
  const module = vm.runInContext('Module', context);
  module.onAbort('InternalError: out of memory');
  assert.match(elements.get('status').textContent, /The game stopped: InternalError: out of memory/);
  assert.match(elements.get('hint').textContent, /ran out of memory while loading/);
  assert.equal(elements.get('hint').hidden, false);
  assert.match(elements.get('diag-text').textContent, /Stopped with: InternalError: out of memory/);
});

test('Save log text has the page details and console output, without the room code', () => {
  const quietConsole = { log() {}, info() {}, warn() {}, error() {} };
  const { context } = setupRoomPage('?room=abcdef123456&log', { gpu: workingGpu, userAgent: 'test-agent' }, {
    console: quietConsole, innerWidth: 800, innerHeight: 600, screen: { width: 1920, height: 1080 }, devicePixelRatio: 2,
  });
  context.Module.print('[web-perf] fps=59.9 room abcdef123456');
  context.Module.printErr('something failed');
  const text = vm.runInContext('buildLogText(60)', context);
  assert.match(text, /^WiiCompiled log saved /);
  assert.match(text, /User agent: test-agent/);
  assert.match(text, /Display refresh: ~60\.0 Hz/);
  assert.match(text, /Window: 800x600, screen 1920x1080, pixel ratio 2/);
  assert.match(text, /s log \[web-perf\] fps=59\.9 room \(room\)/);
  assert.match(text, /s error something failed/);
  assert.match(text, /Detailed logging: on/);
  assert.equal(text.includes('abcdef123456'), false);
});

test('Detailed logging is remembered and turns on the profiler without forwarding', () => {
  const { context, elements, localValues } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' });
  assert.equal(elements.get('detailed-log').checked, false);
  const toggle = elements.get('detailed-log');
  toggle.checked = true;
  toggle.dispatch('change');
  assert.equal(localValues.get('mkw-detailed-log'), '1');
  const second = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, {
    localStorage: { getItem: (key) => key === 'mkw-detailed-log' ? '1' : null, setItem() {}, removeItem() {} },
  });
  assert.equal(second.elements.get('detailed-log').checked, true);
  second.context.Module.preRun[0]();
  assert.equal(second.context.ENV.MKW_WEB_PROFILE, '1');
  assert.equal(second.context.ENV.MKW_WEB_PERF, '1');
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_PROFILE, undefined);
});

// The player's own disc image (mkw_disc_worker.js does the reading; these drive the page).
class FakeWorker {
  static instances = [];
  constructor(url) { this.url = url; this.posted = []; this.terminated = false; FakeWorker.instances.push(this); }
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; }
}
const opened = (overrides = {}) => ({ type: 'opened', gameId: 'RMCE01', region: 'NTSC-U', files: 2007, bytes: 1,
  valid: true, dolOk: true, relOk: true, reason: '', ms: 120, ...overrides });
async function localDiscPage(search = '', overrides = {}) {
  FakeWorker.instances = [];
  const page = setupRoomPage(search, { gpu: workingGpu, userAgent: 'test' }, {
    fetch: noGameFolderFetch, Worker: FakeWorker, BroadcastChannel: class {}, FileReader: class {}, ...overrides,
  });
  await settle();
  page.context.Module._mkw_web_build_game_id = () => 'build-id';
  page.context.Module.UTF8ToString = () => 'RMCE01';
  const pick = (name = 'Mario Kart Wii.wbfs') => {
    const file = { name, size: 1 };
    page.elements.get('disc-file').files = [file];
    page.elements.get('disc-file').dispatch('change');
    return FakeWorker.instances.at(-1);
  };
  return { ...page, pick };
}

test('a staged game folder is played without asking for a disc image', async () => {
  const { context, elements } = setupRoomPage('');
  await settle();
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_DISC, undefined);
  assert.equal(elements.get('disc-panel').hidden, true);
  context.Module.onRuntimeInitialized();
  assert.equal(elements.get('start').disabled, false);
  assert.equal(elements.get('start').textContent, 'Start');
});

test('without a game folder the page asks for a disc image and names its channel to the game', async () => {
  const { context, elements } = await localDiscPage();
  assert.equal(elements.get('disc-panel').hidden, false);
  assert.match(elements.get('disc-status').textContent, /No disc image chosen/);
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_DISC, 'mkw-disc-0123abcd-0000-4000-8000-000000000000');
  context.Module.onRuntimeInitialized();
  assert.equal(elements.get('start').disabled, true);
  assert.equal(elements.get('start').textContent, 'Choose your disc image');
});

test('the probe hands the manifest it downloaded to the game instead of a second download', async () => {
  const requests = [];
  const { context } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' },
    { fetch: siteFetch({ 'game/manifest-v2.txt': stagedManifest, 'game/DATA/sys/boot.bin': '' }, requests) });
  await settle();
  context.Module.preRun[0]();
  assert.deepEqual(requests, [['GET', 'game/manifest-v2.txt'], ['HEAD', 'game/DATA/sys/boot.bin']]);
  assert.match(context.ENV.MKW_WEB_MANIFEST_URL, /^blob:/);
  const { resolveObjectURL } = await import('node:buffer');
  assert.equal(await resolveObjectURL(context.ENV.MKW_WEB_MANIFEST_URL).text(), stagedManifest);
});

test('a staged folder whose boot.bin is only in a file pack is found through the pack', async () => {
  const pack = 'file-packs/' + 'ab'.repeat(32) + '.bin';
  const manifest = stagedManifest + 'p ' + JSON.stringify(['DATA/sys/boot.bin', pack, 0, 1088]).replaceAll(',', ', ') + '\n';
  const requests = [];
  const { context, elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' },
    { fetch: siteFetch({ 'game/manifest-v2.txt': manifest, ['game/' + pack]: '' }, requests) });
  await settle();
  context.Module.preRun[0]();
  assert.deepEqual(requests, [['GET', 'game/manifest-v2.txt'], ['HEAD', 'game/' + pack]]);
  assert.equal(context.ENV.MKW_WEB_DISC, undefined);
  assert.match(context.ENV.MKW_WEB_MANIFEST_URL, /^blob:/);
  assert.equal(elements.get('disc-panel').hidden, true);
});

test('a manifest without the files it lists is not a staged folder', async () => {
  const pack = 'file-packs/' + 'ab'.repeat(32) + '.bin';
  const manifest = stagedManifest + 'p ' + JSON.stringify(['DATA/sys/boot.bin', pack, 0, 1088]) + '\n';
  for (const files of [{ 'game/manifest-v2.txt': stagedManifest }, { 'game/manifest-v2.txt': manifest, 'game/DATA/sys/boot.bin': '' }]) {
    const { context, elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, { fetch: siteFetch(files) });
    await settle();
    context.Module.preRun[0]();
    assert.match(context.ENV.MKW_WEB_DISC, /^mkw-disc-/);
    assert.equal(context.ENV.MKW_WEB_MANIFEST_URL, undefined);
    assert.equal(elements.get('disc-panel').hidden, false);
  }
});

test('?disc=fetch keeps the staged folder even when the probe would find none', async () => {
  const { context, elements } = setupRoomPage('?disc=fetch', { gpu: workingGpu, userAgent: 'test' }, { fetch: noGameFolderFetch });
  await settle();
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_DISC, undefined);
  assert.equal(elements.get('disc-panel').hidden, true);
});

test('a verified disc of the build release enables Start, and starting keeps the panel in the controls', async () => {
  const { context, elements, pick } = await localDiscPage();
  const calls = [];
  context.Module.callMain = (args) => calls.push(args);
  const worker = pick();
  assert.equal(worker.url, 'mkw_disc_worker.js');
  assert.deepEqual(worker.posted.map(({ type, channel }) => [type, channel]),
                   [['open', 'mkw-disc-0123abcd-0000-4000-8000-000000000000']]);
  assert.match(elements.get('disc-status').textContent, /Reading Mario Kart Wii\.wbfs/);
  worker.onmessage({ data: opened() });
  assert.match(elements.get('disc-status').textContent, /waiting for the game to load/);
  assert.equal(elements.get('start').disabled, true);
  context.Module.onRuntimeInitialized();
  assert.match(elements.get('disc-status').textContent, /RMCE01 \(NTSC-U\), main\.dol and StaticR\.rel verified, 2007 files/);
  assert.equal(elements.get('disc-status').className, 'ok');
  assert.equal(elements.get('start').disabled, false);
  elements.get('start').dispatch('click');
  assert.equal(calls.length, 1);
  assert.equal(elements.get('disc-panel').parentNode, elements.get('controls'));
  assert.equal(elements.get('disc-pick').disabled, true);
  pick('another.iso');
  assert.equal(FakeWorker.instances.length, 1, 'no new disc once the game runs');
});

test('another release, a modified dump or an unreadable file keeps Start disabled with the reason', async () => {
  for (const [message, pattern] of [
    [opened({ gameId: 'RMCP01', region: 'PAL' }), /PAL release \(RMCP01\), but this site plays the NTSC-U release \(RMCE01\)/],
    [opened({ valid: false, relOk: false, reason: 'This NTSC-U disc image does not match a clean retail dump.' }), /does not match a clean retail dump/],
    [{ type: 'failed', message: 'This file is not a disc image that can be read.' }, /Mario Kart Wii\.wbfs: This file is not a disc image/],
  ]) {
    const { context, elements, pick } = await localDiscPage();
    context.Module.onRuntimeInitialized();
    pick().onmessage({ data: message });
    assert.match(elements.get('disc-status').textContent, pattern);
    assert.equal(elements.get('disc-status').className, 'error');
    assert.equal(elements.get('start').disabled, true);
  }
});

test('picking again replaces the reader, and a late answer from the old one is ignored', async () => {
  const { context, elements, pick } = await localDiscPage();
  context.Module.onRuntimeInitialized();
  const first = pick('first.wbfs');
  const second = pick('second.wbfs');
  assert.equal(first.terminated, true);
  first.onmessage({ data: opened() });
  assert.equal(elements.get('start').disabled, true);
  second.onmessage({ data: opened() });
  assert.equal(elements.get('start').disabled, false);
  assert.match(elements.get('disc-status').textContent, /second\.wbfs/);
});

test('Clear local game data stops the reader and asks for the disc again', async () => {
  const { context, elements, pick } = await localDiscPage();
  context.Module.onRuntimeInitialized();
  const worker = pick();
  worker.onmessage({ data: opened() });
  assert.equal(elements.get('start').disabled, false);
  elements.get('disc-clear').dispatch('click');
  await settle();
  assert.equal(worker.terminated, true);
  assert.equal(elements.get('start').disabled, true);
  assert.match(elements.get('disc-status').textContent, /Cleared/);
});

// The menu before the game starts (#menu): with a local disc image the disc screen comes first,
// then the two tiles; a staged game folder goes straight to the tiles. A tile or a round button
// opens its channel screen (data-screen="open"); Wii Menu or Escape closes it.
test('a staged game folder opens the menu on the tiles, and a tile opens its channel screen', async () => {
  const { elements } = setupRoomPage('');
  await settle();
  const menu = elements.get('menu');
  assert.equal(menu.dataset.view, 'menu');
  assert.equal(menu.dataset.item, 'solo');
  assert.equal(menu.dataset.screen, '');
  assert.equal(elements.get('disc-chip').hidden, true);
  assert.equal(elements.get('change-disc').hidden, true);
  assert.equal(elements.get('nav-solo').disabled, false);
  elements.get('nav-friends').dispatch('click');
  assert.equal(menu.dataset.item, 'friends');
  assert.equal(menu.dataset.screen, 'open');
  assert.equal(elements.get('menu-back').focused, true);
  assert.equal(elements.get('nav-friends').attributes.get('aria-current'), 'true');
  assert.equal(elements.get('nav-solo').attributes.get('aria-current'), 'false');
  assert.equal(elements.get('foot-desc').textContent, 'Up to 12 players.');
  assert.equal(elements.get('room-reload-note').textContent, 'Creating or joining a room reloads this page.');
  elements.get('menu-back').dispatch('click');
  assert.equal(menu.dataset.screen, '');
  assert.equal(menu.dataset.item, 'friends', 'closing a screen keeps the choice');
  assert.equal(elements.get('nav-friends').focused, true);
  elements.get('nav-controls').dispatch('click');
  assert.equal(menu.dataset.item, 'controls');
  assert.equal(menu.dataset.screen, 'open');
  menu.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.dataset.screen, '');
  assert.equal(elements.get('nav-controls').focused, true);
  // Arrow keys move between the two tiles without opening anything.
  let prevented = false;
  elements.get('menu-nav').dispatch('keydown', { key: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(menu.dataset.item, 'controls');
  assert.equal(menu.dataset.screen, '');
  assert.equal(elements.get('nav-friends').focused, true);
  elements.get('foot-help').dispatch('click');
  assert.equal(elements.get('problems-dialog').open, true);
  elements.get('problems-dialog').open = false;
  elements.get('open-problems').dispatch('click');
  assert.equal(elements.get('problems-dialog').open, true);
});

test('with a local disc image the disc screen comes first and the menu follows a verified disc', async () => {
  const { context, elements, pick } = await localDiscPage();
  const menu = elements.get('menu');
  const panel = elements.get('disc-panel');
  assert.equal(menu.dataset.view, 'disc');
  assert.equal(panel.dataset.disc, 'none');
  assert.equal(elements.get('disc-pick').textContent, 'Choose disc image…');
  assert.equal(elements.get('disc-back').hidden, true);
  const worker = pick();
  assert.equal(panel.dataset.disc, 'reading');
  assert.equal(menu.dataset.view, 'disc');
  worker.onmessage({ data: opened() });
  assert.equal(menu.dataset.view, 'menu', 'the menu opens before the game has finished loading');
  assert.equal(menu.dataset.item, 'solo');
  assert.equal(elements.get('nav-solo').focused, true);
  assert.equal(elements.get('disc-chip').hidden, false);
  assert.equal(elements.get('disc-chip-text').textContent, 'RMCE01 · NTSC-U');
  assert.equal(elements.get('solo-disc').textContent, 'Mario Kart Wii.wbfs · RMCE01 (NTSC-U), verified');
  assert.equal(menu.classList.contains('loaded'), false);
  context.Module.onRuntimeInitialized();
  assert.equal(menu.dataset.view, 'menu');
  assert.equal(menu.classList.contains('loaded'), true);

  elements.get('change-disc').dispatch('click');
  assert.equal(menu.dataset.view, 'disc');
  assert.equal(panel.dataset.disc, 'ok');
  assert.equal(elements.get('disc-back').hidden, false);
  assert.equal(elements.get('disc-pick').textContent, 'Choose a different disc image…');
  elements.get('disc-back').dispatch('click');
  assert.equal(menu.dataset.view, 'menu');

  elements.get('change-disc').dispatch('click');
  pick('second.wbfs').onmessage({ data: opened() });
  assert.equal(menu.dataset.view, 'menu', 'a new verified disc returns to the menu');
  assert.match(elements.get('solo-disc').textContent, /^second\.wbfs/);
});

test('a disc the game cannot play keeps or brings back the disc screen', async () => {
  const early = await localDiscPage();
  early.pick().onmessage({ data: opened({ gameId: 'RMCP01', region: 'PAL' }) });
  assert.equal(early.elements.get('menu').dataset.view, 'menu', 'the release is only known once the game has loaded');
  early.context.Module.onRuntimeInitialized();
  assert.equal(early.elements.get('menu').dataset.view, 'disc');
  assert.match(early.elements.get('disc-status').textContent, /this site plays the NTSC-U release/);
  assert.equal(early.elements.get('disc-chip').hidden, true);

  const modified = await localDiscPage();
  modified.pick().onmessage({ data: opened({ valid: false, relOk: false, reason: 'Not a clean retail dump.' }) });
  assert.equal(modified.elements.get('menu').dataset.view, 'disc');
  assert.equal(modified.elements.get('disc-panel').dataset.disc, 'none');
});

test('Clear local game data returns from the menu to the disc screen', async () => {
  const { context, elements, pick } = await localDiscPage();
  context.Module.onRuntimeInitialized();
  pick().onmessage({ data: opened() });
  elements.get('change-disc').dispatch('click');
  elements.get('disc-clear').dispatch('click');
  await settle();
  assert.equal(elements.get('menu').dataset.view, 'disc');
  assert.equal(elements.get('disc-back').hidden, true);
  assert.equal(elements.get('disc-panel').dataset.disc, 'none');
});

test('a room link opens the menu on Play with friends, with Start beside the lobby', async () => {
  const { elements } = setupRoomPage();
  await settle();
  const menu = elements.get('menu');
  assert.equal(menu.dataset.view, 'menu');
  assert.equal(menu.dataset.item, 'friends');
  assert.equal(menu.dataset.screen, 'open');
  assert.equal(elements.get('nav-solo').disabled, true);
  assert.equal(elements.get('nav-solo-desc').textContent, 'Leave the room to play solo');
  assert.equal(elements.get('start').parentNode, elements.get('start-slot-friends'));
  assert.equal(elements.get('room-reload-note').hidden, true);
  elements.get('menu-nav').dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(menu.dataset.item, 'friends', 'the room keeps the menu on Play with friends');
});

test('a room link without a disc image asks for the disc first, then shows the lobby', async () => {
  const { elements, pick } = await localDiscPage('?room=abcdef');
  const menu = elements.get('menu');
  assert.equal(menu.dataset.view, 'disc');
  assert.equal(elements.get('disc-invite').hidden, false);
  pick().onmessage({ data: opened() });
  assert.equal(menu.dataset.view, 'menu');
  assert.equal(menu.dataset.item, 'friends');
  assert.equal(menu.dataset.screen, 'open', 'a room link opens the Play with friends screen');
  assert.equal(elements.get('menu-back').focused, true);
});

test('Start closes the menu and hands its blocks to the controls panel', async () => {
  const { context, elements, body } = setupRoomPage('');
  await settle();
  const controls = elements.get('controls');
  const menu = elements.get('menu');
  context.Module.callMain = () => {};
  context.Module.onRuntimeInitialized();
  elements.get('open-problems').dispatch('click');
  assert.equal(body.classList.contains('pregame'), true);
  elements.get('start').dispatch('click');
  assert.equal(menu.hidden, true);
  assert.equal(body.classList.contains('pregame'), false);
  assert.equal(elements.get('problems-dialog').open, false);
  for (const id of ['bindings-block', 'saves-panel', 'problems-block']) {
    assert.equal(elements.get(id).parentNode, controls, `${id} moves to the controls panel`);
  }
  assert.equal(elements.get('status').parentNode, elements.get('overlay'));
  menu.dataset.view = 'kept';
  elements.get('nav-friends').dispatch('click');
  assert.equal(menu.dataset.view, 'kept', 'the menu is not redrawn once the game runs');
});

// In the game the menu is a button in the corner that opens into a pill (#dock); a pill item
// opens its block as a card in #controls, and closing the pill closes the card.
test('in the game the corner button opens the pill and a pill item opens its card', async () => {
  const { context, elements } = setupRoomPage('');
  await settle();
  const dock = elements.get('dock'), controls = elements.get('controls'), toggle = elements.get('dock-toggle');
  context.Module.callMain = () => {};
  context.Module.onRuntimeInitialized();
  assert.equal(elements.get('dock-room').hidden, true, 'no room item outside a room');
  elements.get('start').dispatch('click');
  assert.equal(elements.get('stage').classList.contains('awake'), true, 'the button shows as the game starts');
  toggle.dispatch('click');
  assert.equal(dock.classList.contains('open'), true);
  assert.equal(toggle.attributes.get('aria-expanded'), 'true');
  elements.get('dock-controls').dispatch('click');
  assert.equal(controls.dataset.card, 'controls');
  assert.equal(controls.hidden, false);
  assert.equal(elements.get('dock-controls').attributes.get('aria-expanded'), 'true');
  elements.get('dock-help').dispatch('click');
  assert.equal(controls.dataset.card, 'help');
  assert.equal(elements.get('dock-controls').attributes.get('aria-expanded'), 'false');
  elements.get('dock-help').dispatch('click');
  assert.equal(controls.hidden, true, 'the same item closes its card');
  elements.get('dock-saves').dispatch('click');
  toggle.dispatch('click');
  assert.equal(dock.classList.contains('open'), false);
  assert.equal(controls.hidden, true, 'closing the pill closes the card');
  assert.equal(toggle.attributes.get('aria-expanded'), 'false');
});

test('in a room the pill has a room item that carries the head count', async () => {
  const { context, elements } = setupRoomPage();
  await settle();
  assert.equal(elements.get('dock-room').hidden, false);
  context.window.mkwSetRoomPlayers(JSON.stringify({ players: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }), 1);
  assert.equal(elements.get('room-count').textContent, '2 / 12');
  assert.equal(elements.get('dock-room-count').textContent, '2 / 12');
});

test('a failure before Start replaces the menu with its message', async () => {
  const { context, elements, body } = setupRoomPage('');
  await settle();
  context.Module.onAbort('test failure');
  assert.equal(elements.get('menu').hidden, true);
  assert.equal(elements.get('status').parentNode, elements.get('overlay'));
  assert.equal(elements.get('reload').hidden, false);
  assert.equal(body.classList.contains('pregame'), true, 'the failure shows on the full page');
  assert.notEqual(elements.get('bindings-block').parentNode, elements.get('controls'));
});

test('loading messages drive the bar, and other status text shows as a notice', async () => {
  const { context, elements } = setupRoomPage('');
  await settle();
  const sync = () => vm.runInContext('syncLoadStatus()', context);
  const bar = elements.get('load-bar'), fill = elements.get('load-fill'), strip = elements.get('foot-load');
  context.Module.setStatus('Downloading data... (50/200)');
  sync();
  assert.equal(bar.classList.contains('known'), true);
  assert.equal(fill.style.width, '25.0%');
  assert.equal(elements.get('load-pct').textContent, '25%');
  assert.equal(strip.classList.contains('notice'), false);
  context.Module.setStatus('Downloading data...');
  sync();
  assert.equal(bar.classList.contains('known'), false);
  assert.equal(fill.style.width, '');
  assert.equal(strip.classList.contains('notice'), false);
  elements.get('status').textContent = 'Mario Kart Wii is already open in another tab of this browser.';
  sync();
  assert.equal(strip.classList.contains('notice'), true);
  context.Module.setStatus('');
  sync();
  assert.equal(strip.classList.contains('notice'), false);
});

test('Create room uses the local relay on 127.0.0.1 and the page\'s mkw-rooms-host tag elsewhere', async () => {
  const cases = [
    [{ href: 'http://127.0.0.1:8000/WiiCompiled.html', hostname: '127.0.0.1', search: '' }, 'http://127.0.0.1:8787/v1/rooms'],
    [{ href: 'https://game.test/WiiCompiled.html', hostname: 'game.test', search: '' }, 'https://rooms.example.test/v1/rooms'],
  ];
  for (const [location, expected] of cases) {
    const requests = [];
    const fetch = async (url, options) => {
      if (!String(url).includes('/v1/rooms')) return stagedSiteFetch(url, options);
      requests.push(String(url));
      return { ok: true, json: async () => ({ code: 'abcdefghjkmn' }) };
    };
    const { context, elements } = setupRoomPage('?', { gpu: workingGpu, userAgent: 'test' }, { location, fetch });
    elements.get('create-room').dispatch('click');
    for (let n = 0; n < 10 && !requests.length; n++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [expected]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(new URL(context.location.href).searchParams.get('room'), 'abcdefghjkmn');
  }
});

test('a ws:// room parameter names the relay socket directly', () => {
  const { sockets } = setupRoomPage('?room=ws://127.0.0.1:9999/v1/rooms/abcdefghjkmn/ws');
  assert.equal(sockets[0]?.url, 'ws://127.0.0.1:9999/v1/rooms/abcdefghjkmn/lobby');
});
