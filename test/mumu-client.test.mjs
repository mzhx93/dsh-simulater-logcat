import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const clientSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const expectedBundleId = "@mzhx93/dsh-simulater-logcat";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/** Execute the real bundle/component, but own every browser effect and I/O primitive.
 * Only a test-local export is added to the VM copy; the checked-in runtime is untouched.
 * Child function components remain React elements because these tests target the panel.
 */
function makeHarness({ fetch, protocol = "http:", hostname = "127.0.0.1", storedSerial = "", embedded = true } = {}) {
  const hooks = [];
  const effects = new Map();
  const pendingEffects = new Map();
  const backgroundRequests = [];
  const sockets = [];
  const unexpectedRequests = [];
  const lateUpdates = [];
  let hookIndex = 0;
  let dirty = true;
  let mounted = true;
  let currentTree = null;
  const storage = new Map(storedSerial === "" ? [] : [["dsh-logcat-serial", storedSerial]]);
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const listeners = new Map();
  const fakeWindow = {
    location: { protocol, hostname, host: hostname },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const document = { activeElement: null, fullscreenElement: null, querySelector() { return null; } };
  const clock = {
    now: 0,
    nextId: 1,
    timers: new Map(),
    setTimeout(fn, delay = 0) {
      const id = this.nextId++;
      this.timers.set(id, { fn, due: this.now + Number(delay) });
      return id;
    },
    setInterval(fn, delay) {
      const id = this.setTimeout(fn, delay);
      this.timers.get(id).interval = Number(delay);
      return id;
    },
    clear(id) { this.timers.delete(id); },
    advance(ms) {
      const end = this.now + ms;
      let iterations = 0;
      while (true) {
        assert.ok(iterations++ < 10000, "fake timers must settle");
        const next = [...this.timers.entries()]
          .filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (next === undefined) break;
        const [id, timer] = next;
        this.now = timer.due;
        if (timer.interval === undefined) this.timers.delete(id);
        else timer.due += timer.interval;
        timer.fn();
      }
      this.now = end;
    },
  };
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    message(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  function createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) };
  }
  function sameDeps(left, right) {
    return left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  }
  const react = {
    createElement,
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], value => {
        if (!mounted) { lateUpdates.push(index); return; }
        const next = typeof value === "function" ? value(hooks[index]) : value;
        if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory, deps) {
      const index = hookIndex++;
      if (!(index in hooks) || !sameDeps(hooks[index].deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!effects.has(index) || !sameDeps(effects.get(index).deps, deps)) pendingEffects.set(index, { effect, deps });
    },
    useSyncExternalStore(_subscribe, getSnapshot) { hookIndex++; return getSnapshot(); },
  };
  const fakeFetch = (url, options = {}) => {
    // Route all actual effects through a strict allowlist. No native fetch is reachable.
    // MuMu calls go to each test's controlled responder, including unexpected mount calls.
    if (String(url).startsWith("/api/dsh-logcat/mumu/")) {
      if (fetch === undefined) throw new Error("unexpected MuMu fetch: " + url);
      return fetch(url, options);
    }
    backgroundRequests.push({ url, options });
    if (url === "/api/dsh-logcat/status") return Promise.resolve(response({ ready: false, devices: [] }));
    if (url.startsWith("/api/dsh-logcat/stats?")) return Promise.resolve(response({ ready: false }));
    if (url.startsWith("/api/dsh-logcat/processes?")) return Promise.resolve(response({ processes: [] }));
    unexpectedRequests.push({ url, options });
    return Promise.reject(new Error("unexpected background fetch: " + url));
  };

  let registered;
  fakeWindow.__ModuleLoader__ = { load(bundle) { registered = bundle; } };
  const instrumented = clientSource.replace(
    "exports.apply = apply;",
    "exports.__test = { LogcatPanel, PanelController }; exports.apply = apply;",
  );
  assert.notEqual(instrumented, clientSource, "test export anchor must match the requested bundle");
  vm.runInNewContext(instrumented, {
    window: fakeWindow,
    document,
    localStorage,
    fetch: fakeFetch,
    AbortController,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clear.bind(clock),
    setInterval: clock.setInterval.bind(clock),
    clearInterval: clock.clear.bind(clock),
    requestAnimationFrame: fn => clock.setTimeout(fn, 16),
    cancelAnimationFrame: clock.clear.bind(clock),
    WebSocket: FakeWebSocket,
    console,
  }, { filename: "lib/client.js" });
  assert.equal(registered?.id, expectedBundleId, "exercise only @mzhx93/dsh-simulater-logcat");
  const moduleExports = registered.factory(name => {
    if (name === "react") return react;
    if (name === "react-dom/client") return { createRoot() { throw new Error("root mounting is not used"); } };
    throw new Error("unexpected module: " + name);
  });
  const controller = new moduleExports.__test.PanelController();
  controller.open();
  const Panel = moduleExports.__test.LogcatPanel;

  function render() {
    assert.equal(mounted, true, "must not render an unmounted panel");
    let renders = 0;
    do {
      assert.ok(renders++ < 25, "hook render/effect loop must settle");
      hookIndex = 0;
      dirty = false;
      currentTree = Panel({ controller, embedded });
      const queued = [...pendingEffects];
      pendingEffects.clear();
      for (const [index, { effect, deps }] of queued) {
        effects.get(index)?.cleanup?.();
        effects.set(index, { deps, cleanup: effect() });
      }
    } while (dirty);
    return currentTree;
  }
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      if (mounted && dirty) render();
    }
    assert.deepEqual(unexpectedRequests, [], "no unmocked background endpoint may run");
    assert.equal(dirty && mounted, false, "all queued state updates must settle");
  }
  function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const { cleanup } of effects.values()) cleanup?.();
    effects.clear();
    // React ignores state setters after unmount; the WS close handler does call one.
    // Tests compare the count after this synchronous cleanup against later MuMu results.
  }
  render();
  return {
    render, flush, unmount, clock, localStorage, controller, sockets, backgroundRequests, lateUpdates,
    get tree() { return currentTree; },
  };
}

async function mountPanel(t, options = {}) {
  const harness = makeHarness(options);
  t.after(() => harness.unmount());
  await harness.flush();
  return harness;
}

function walk(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children ?? []) walk(child, predicate, found);
  return found;
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  return (node.children ?? []).map(textOf).join("");
}

function findConnectButton(harness) {
  const button = walk(harness.tree, node => node.type === "button" && /^(连接 MuMu|连接中…)$/u.test(textOf(node)))[0];
  assert.ok(button, "renders the explicit MuMu connect button");
  return button;
}

function findMuMuSelect(harness) {
  return walk(harness.tree, node => node.type === "select" && node.props["aria-label"] === "MuMu 实例")[0];
}

function normalizedHeaders(options) {
  return JSON.parse(JSON.stringify(options.headers));
}

function deviceSelect(harness) {
  return walk(harness.tree, node => node.type === "select" && node.props.title === "选择设备")[0];
}

test("discovers only after button click and connects one ready instance", async t => {
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/mumu/instances")) return response({ available: true, instances: [{ id: "0", name: "MuMu 12", serial: "127.0.0.1:16384" }] });
    if (url.endsWith("/mumu/connect")) return response({ ok: true, serial: "127.0.0.1:16384", instance: { id: "0" }, devices: [
      { serial: "127.0.0.1:16384", state: "device", model: "MuMu" },
      { serial: "offline", state: "unauthorized", model: "Other" },
    ] });
    throw new Error("unexpected request: " + url);
  } });

  assert.equal(requests.length, 0, "mounting the panel must not discover MuMu");
  assert.equal(harness.sockets.length, 1, "actual component WS effect uses the stub");
  assert.equal(harness.backgroundRequests[0].url, "/api/dsh-logcat/status");
  harness.sockets[0].open();
  harness.sockets[0].message({ type: "ready", devices: [] });
  harness.controller.close();
  harness.render();
  harness.controller.open();
  harness.render();
  harness.clock.advance(4000);
  await harness.flush();
  assert.equal(requests.length, 0, "ready frames, normal polling, and re-opening must not discover MuMu");
  await findConnectButton(harness).props.onClick();
  harness.render();

  assert.deepEqual(requests.map(request => [request.url, request.options.method]), [
    ["/api/dsh-logcat/mumu/instances", "GET"],
    ["/api/dsh-logcat/mumu/connect", "POST"],
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), { instanceId: "0" });
  assert.deepEqual(normalizedHeaders(requests[0].options), { "x-dsh-logcat": "1" });
  assert.deepEqual(normalizedHeaders(requests[1].options), { "x-dsh-logcat": "1", "content-type": "application/json" });
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.equal(requests[1].options.credentials, "same-origin");
  assert.equal("body" in requests[0].options, false, "discovery is a bodyless GET");
  assert.equal(requests[0].options.signal, requests[1].options.signal, "one lifecycle/timeout owns both steps");
  assert.equal(harness.sockets[0].sent.some(frame => frame.type === "replay"), true, "selection uses the ordinary replay path");
  assert.equal(harness.sockets[0].sent.some(frame => frame.type === "connect"), false, "MuMu does not invent a WS connection path");
  assert.equal(deviceSelect(harness).props.value, "127.0.0.1:16384", "one online device is selected automatically");
  assert.match(textOf(harness.tree), /已连接并验证在线/);
});

test("multiple instances require selection and a second explicit click", async t => {
  const requests = [];
  const instances = [
    { id: "0", name: "MuMu A", serial: "127.0.0.1:16384" },
    { id: "1", name: "MuMu B", serial: "127.0.0.1:16416" },
  ];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances")
      ? response({ available: true, instances })
      : response({ ok: true, serial: "127.0.0.1:16416", instance: instances[1], devices: [] });
  } });

  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.length, 1, "discovery must not choose among multiple instances");
  assert.equal(findMuMuSelect(harness).props.value, "");
  assert.match(textOf(findMuMuSelect(harness)), /MuMu A · 127.0.0.1:16384/);
  assert.match(textOf(findMuMuSelect(harness)), /MuMu B · 127.0.0.1:16416/);
  assert.match(textOf(harness.tree), /发现多个运行实例/);

  findMuMuSelect(harness).props.onChange({ target: { value: "1" } });
  harness.render();
  await harness.flush();
  assert.equal(requests.length, 1, "changing the selection is not permission to connect");
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.filter(request => request.url.endsWith("/mumu/instances")).length, 2, "the second click performs fresh explicit discovery");
  assert.equal(requests.filter(request => request.url.endsWith("/mumu/connect")).length, 1);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { instanceId: "1" });
});

test("does not auto-select when more than one discovered device is online", async t => {
  const harness = await mountPanel(t, { fetch: async url => url.endsWith("/mumu/instances")
    ? response({ available: true, instances: [{ id: "0", name: "MuMu", serial: "127.0.0.1:16384" }] })
    : response({ ok: true, serial: "127.0.0.1:16384", instance: { id: "0" }, devices: [
      { serial: "127.0.0.1:16384", state: "device", model: "A" },
      { serial: "127.0.0.1:16416", state: "device", model: "B" },
    ] }) });
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(deviceSelect(harness).props.value, "");
});

test("shows discovery diagnostics without attempting a connection", async t => {
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return response({ available: false, instances: [], diagnostic: { code: "not-ready", message: "Android is still booting" } });
  } });
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/dsh-logcat/mumu/instances");
  const alert = walk(harness.tree, node => node.props.role === "alert")[0];
  assert.ok(alert);
  assert.equal(textOf(alert), "Android is still booting");
});

test("locks duplicate requests while discovery is pending", async t => {
  const pending = deferred();
  let discoveryCalls = 0;
  const harness = await mountPanel(t, { fetch: async url => {
    assert.ok(url.endsWith("/mumu/instances"));
    discoveryCalls++;
    return pending.promise;
  } });
  const staleHandler = findConnectButton(harness).props.onClick;
  const firstClick = staleHandler();
  await staleHandler(); // Same render, before React commits the disabled attribute.
  harness.render();
  const button = findConnectButton(harness);
  assert.equal(button.props.disabled, true);
  await button.props.onClick(); // Ref lock also guards direct invocation of disabled controls.
  assert.equal(discoveryCalls, 1);
  pending.resolve(response({ available: true, instances: [], diagnostic: { code: "empty", message: "none" } }));
  await firstClick;
  harness.render();
  assert.equal(discoveryCalls, 1);
});

test("reports timeout and never connects after an aborted discovery", async t => {
  const requests = [];
  const harness = await mountPanel(t, { fetch: (url, options) => {
    requests.push({ url, options });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  } });
  const pending = findConnectButton(harness).props.onClick();
  harness.render();
  harness.clock.advance(29999);
  assert.equal(requests[0].options.signal.aborted, false);
  harness.clock.advance(1);
  await pending;
  harness.render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/dsh-logcat/mumu/instances");
  assert.match(textOf(harness.tree), /连接超时（30 秒）/);
  assert.equal(findConnectButton(harness).props.disabled, false);
  harness.clock.advance(60000);
  await harness.flush();
  assert.equal(requests.length, 1, "timeout is not permission for an automatic retry");
});

test("surfaces HTTP errors and does not send a connect request", async t => {
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances")
      ? response({ error: "discovery denied" }, { ok: false, status: 403 })
      : response({ ok: true });
  } });
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.length, 1);
  assert.match(textOf(harness.tree), /discovery denied/);
});

test("does not issue a late connection after the panel unmounts", async t => {
  const pending = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return pending.promise;
  } });
  const click = findConnectButton(harness).props.onClick();
  harness.unmount();
  assert.equal(requests[0].options.signal.aborted, true);
  const lateUpdatesBeforeResult = harness.lateUpdates.length;
  pending.resolve(response({ available: true, instances: [{ id: "0", name: "MuMu", serial: "127.0.0.1:16384" }] }));
  await click;
  assert.equal(harness.lateUpdates.length, lateUpdatesBeforeResult, "late discovery may not update an unmounted panel");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/dsh-logcat/mumu/instances");
});

test("uses required custom headers and the desktop marker for dsh-app://app", async t => {
  const requests = [];
  const harness = await mountPanel(t, { protocol: "dsh-app:", hostname: "app", fetch: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances")
      ? response({ available: true, instances: [{ id: "desktop-0", name: "MuMu Desktop", serial: "127.0.0.1:16384" }] })
      : response({ ok: true, serial: "127.0.0.1:16384", instance: { id: "desktop-0" }, devices: [] });
  } });
  await findConnectButton(harness).props.onClick();

  assert.deepEqual(normalizedHeaders(requests[0].options), {
    "x-dsh-logcat": "1",
    "x-dsh-logcat-client": "desktop",
  });
  assert.deepEqual(normalizedHeaders(requests[1].options), {
    "x-dsh-logcat": "1",
    "x-dsh-logcat-client": "desktop",
    "content-type": "application/json",
  });
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.body, JSON.stringify({ instanceId: "desktop-0" }));
});

const readyInstance = { id: "0", name: "MuMu 12", serial: "127.0.0.1:16384" };
const readyDiscovery = () => response({ available: true, instances: [readyInstance] });
const connectedResponse = (devices = []) => response({ ok: true, serial: readyInstance.serial, instance: readyInstance, devices });

for (const { name, storedSerial, devices, expected } of [
  { name: "preserves an already online device instead of stealing selection", storedSerial: "usb-device", devices: [
    { serial: "usb-device", state: "device", model: "Phone" },
    { serial: readyInstance.serial, state: "device", model: "MuMu" },
  ], expected: "usb-device" },
  { name: "replaces an offline remembered selection only for a sole online device", storedSerial: "usb-device", devices: [
    { serial: "usb-device", state: "offline", model: "Phone" },
    { serial: readyInstance.serial, state: "device", model: "MuMu" },
  ], expected: readyInstance.serial },
  { name: "does not select offline or unauthorized devices", storedSerial: "", devices: [
    { serial: readyInstance.serial, state: "offline", model: "MuMu" },
    { serial: "usb-device", state: "unauthorized", model: "Phone" },
  ], expected: "" },
  { name: "keeps a remembered selection when several devices are online", storedSerial: "previous", devices: [
    { serial: readyInstance.serial, state: "device", model: "MuMu" },
    { serial: "usb-device", state: "device", model: "Phone" },
  ], expected: "previous" },
]) {
  test(name, async t => {
    const harness = await mountPanel(t, { storedSerial, fetch: async url => url.endsWith("/mumu/instances")
      ? readyDiscovery() : connectedResponse(devices) });
    assert.equal(deviceSelect(harness).props.value, storedSerial);
    await findConnectButton(harness).props.onClick();
    await harness.flush();
    harness.render();
    assert.equal(deviceSelect(harness).props.value, expected);
    assert.equal(harness.localStorage.getItem("dsh-logcat-serial") ?? "", expected);
  });
}

test("does not POST a stale instance ID missing from refreshed discovery", async t => {
  const requests = [];
  let discoveryCount = 0;
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    if (!url.endsWith("/mumu/instances")) return connectedResponse();
    discoveryCount++;
    return response({ available: true, instances: discoveryCount === 1
      ? [readyInstance, { id: "1", name: "MuMu B", serial: "127.0.0.1:16416" }]
      : [{ id: "2", name: "MuMu C", serial: "127.0.0.1:16448" }, { id: "3", name: "MuMu D", serial: "127.0.0.1:16480" }] });
  } });
  await findConnectButton(harness).props.onClick();
  harness.render();
  findMuMuSelect(harness).props.onChange({ target: { value: "1" } });
  harness.render();
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.length, 2, "fresh discovery invalidates a vanished selection rather than POSTing it");
  assert.equal(findMuMuSelect(harness).props.value, "");
  assert.match(textOf(harness.tree), /请选择实例|选择后再次点击/);
});

test("a vanished selected instance is never replaced by the sole remaining instance", async t => {
  const requests = [];
  let scans = 0;
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    assert.ok(url.endsWith("/mumu/instances"), "must not connect a different instance");
    scans++;
    return response({ available: true, instances: scans === 1
      ? [readyInstance, { id: "1", name: "MuMu B", serial: "127.0.0.1:16416" }]
      : [readyInstance] });
  } });
  await findConnectButton(harness).props.onClick();
  harness.render();
  findMuMuSelect(harness).props.onChange({ target: { value: "1" } });
  harness.render();
  await findConnectButton(harness).props.onClick();
  harness.render();
  assert.equal(requests.length, 2);
  assert.match(textOf(walk(harness.tree, node => node.props.role === "alert")[0]), /所选 MuMu 实例已不可用/);
  assert.equal(findConnectButton(harness).props.disabled, false);
});

test("holds the duplicate lock and disables the selector until POST completes", async t => {
  const post = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances") ? Promise.resolve(response({ available: true, instances: [
      readyInstance, { id: "1", name: "MuMu B", serial: "127.0.0.1:16416" },
    ] })) : post.promise;
  } });
  await findConnectButton(harness).props.onClick();
  harness.render();
  findMuMuSelect(harness).props.onChange({ target: { value: "0" } });
  harness.render();
  const handler = findConnectButton(harness).props.onClick;
  const click = handler();
  await harness.flush();
  assert.equal(requests.length, 3, "second discovery reaches a single pending POST");
  assert.equal(findConnectButton(harness).props.disabled, true);
  assert.equal(findMuMuSelect(harness).props.disabled, true);
  await handler();
  await findConnectButton(harness).props.onClick();
  assert.equal(requests.length, 3);
  post.resolve(connectedResponse());
  await click;
  harness.render();
  assert.equal(findConnectButton(harness).props.disabled, false);
  assert.equal(findMuMuSelect(harness).props.disabled, false);
});

for (const { name, body, note, isError } of [
  { name: "empty ready discovery", body: { available: true, instances: [] }, note: /未发现就绪的 MuMu 实例/, isError: false },
  { name: "unavailable discovery with a candidate", body: { available: false, instances: [readyInstance], diagnostic: { code: "not-ready", message: "MuMu is not ready" } }, note: /MuMu is not ready/, isError: true },
  { name: "diagnostic on available but empty discovery", body: { available: true, instances: [], diagnostic: { code: "booting", message: "Please wait for Android" } }, note: /Please wait for Android/, isError: true },
]) {
  test(name + " never triggers POST or automatic retry", async t => {
    const requests = [];
    const harness = await mountPanel(t, { fetch: async (url, options) => {
      requests.push({ url, options });
      return response(body);
    } });
    await findConnectButton(harness).props.onClick();
    harness.render();
    harness.clock.advance(60000);
    await harness.flush();
    assert.equal(requests.length, 1);
    assert.match(textOf(harness.tree), note);
    assert.equal(walk(harness.tree, node => node.props.role === "alert").length > 0, isError);
    assert.equal(findConnectButton(harness).props.disabled, false);
  });
}

for (const { name, stage, fail, expected } of [
  { name: "network rejection", stage: "instances", fail: () => Promise.reject(new Error("network unavailable")), expected: /network unavailable/ },
  { name: "invalid discovery JSON", stage: "instances", fail: () => ({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }), expected: /invalid JSON/ },
  { name: "HTTP connect rejection", stage: "connect", fail: () => response({ error: "connect denied" }, { ok: false, status: 403 }), expected: /connect denied/ },
  { name: "unsuccessful connect", stage: "connect", fail: () => response({ ok: false, error: "port no longer online" }), expected: /port no longer online/ },
  { name: "HTTP status fallback", stage: "connect", fail: () => response({}, { ok: false, status: 503 }), expected: /HTTP 503/ },
]) {
  test(name + " is visible and releases the lock for an explicit retry", async t => {
    const requests = [];
    let failing = true;
    const harness = await mountPanel(t, { fetch: async (url, options) => {
      requests.push({ url, options });
      if (failing && url.endsWith("/mumu/" + stage)) return fail();
      return url.endsWith("/mumu/instances") ? readyDiscovery() : connectedResponse();
    } });
    await findConnectButton(harness).props.onClick();
    harness.render();
    assert.match(textOf(walk(harness.tree, node => node.props.role === "alert")[0]), expected);
    assert.equal(findConnectButton(harness).props.disabled, false);
    const beforeRetry = requests.length;
    assert.equal(beforeRetry, stage === "instances" ? 1 : 2);
    failing = false;
    await findConnectButton(harness).props.onClick();
    harness.render();
    assert.equal(requests.length, beforeRetry + 2);
    assert.match(textOf(harness.tree), /已连接并验证在线/);
    assert.equal(walk(harness.tree, node => node.props.role === "alert").length, 0);
  });
}

test("closing the drawer cancels pending recovery and clears the searching note", async t => {
  const discovery = deferred();
  const requests = [];
  const harness = await mountPanel(t, { embedded: false, fetch: (url, options) => {
    requests.push({ url, options });
    return discovery.promise;
  } });
  const click = findConnectButton(harness).props.onClick();
  harness.controller.close();
  harness.render();
  await click;
  harness.controller.open();
  harness.render();
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(findConnectButton(harness).props.disabled, false);
  assert.match(textOf(harness.tree), /MuMu 连接已取消/);
  assert.doesNotMatch(textOf(harness.tree), /正在查找运行中的 MuMu/);
  discovery.resolve(readyDiscovery());
  await harness.flush();
  assert.equal(requests.length, 1);
});

test("late discovery after timeout cannot issue POST even when fetch ignores abort", async t => {
  const discovery = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: (url, options) => {
    requests.push({ url, options });
    return discovery.promise;
  } });
  const click = findConnectButton(harness).props.onClick();
  harness.clock.advance(30000);
  assert.equal(requests[0].options.signal.aborted, true);
  await click;
  harness.render();
  assert.equal(findConnectButton(harness).props.disabled, false);
  assert.match(textOf(walk(harness.tree, node => node.props.role === "alert")[0]), /超时/);
  discovery.resolve(readyDiscovery());
  await Promise.resolve();
  harness.render();
  assert.equal(requests.length, 1);
  assert.equal(findMuMuSelect(harness), undefined);
  assert.doesNotMatch(textOf(harness.tree), /已连接并验证在线/);
});

test("late discovery JSON after timeout cannot issue POST", async t => {
  const json = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: () => json.promise };
  } });
  const click = findConnectButton(harness).props.onClick();
  await harness.flush();
  harness.clock.advance(30000);
  json.resolve({ available: true, instances: [readyInstance] });
  await click;
  harness.render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.doesNotMatch(textOf(harness.tree), /已连接并验证在线/);
});

test("POST timeout ignores a late success instead of selecting a device", async t => {
  const post = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances") ? readyDiscovery() : post.promise;
  } });
  const click = findConnectButton(harness).props.onClick();
  await harness.flush();
  assert.equal(requests.length, 2);
  harness.clock.advance(30000);
  await click;
  harness.render();
  assert.equal(findConnectButton(harness).props.disabled, false);
  assert.match(textOf(walk(harness.tree, node => node.props.role === "alert")[0]), /超时/);
  post.resolve(connectedResponse([{ serial: readyInstance.serial, state: "device", model: "MuMu" }]));
  await Promise.resolve();
  harness.render();
  assert.equal(requests[1].options.signal.aborted, true);
  assert.equal(deviceSelect(harness).props.value, "");
  assert.equal(harness.localStorage.getItem("dsh-logcat-serial"), null);
  assert.doesNotMatch(textOf(harness.tree), /已连接并验证在线/);
});

test("unmount during POST suppresses late state, storage, replay, and further requests", async t => {
  const post = deferred();
  const requests = [];
  const harness = await mountPanel(t, { fetch: async (url, options) => {
    requests.push({ url, options });
    return url.endsWith("/mumu/instances") ? readyDiscovery() : post.promise;
  } });
  harness.sockets[0].open();
  await harness.flush();
  const staleHandler = findConnectButton(harness).props.onClick;
  const click = staleHandler();
  await harness.flush();
  assert.equal(requests.length, 2);
  harness.unmount();
  const updates = harness.lateUpdates.length;
  const sent = harness.sockets[0].sent.length;
  assert.equal(requests[1].options.signal.aborted, true);
  post.resolve(connectedResponse([{ serial: readyInstance.serial, state: "device", model: "MuMu" }]));
  await click;
  await staleHandler();
  assert.equal(harness.lateUpdates.length, updates);
  assert.equal(harness.sockets[0].sent.length, sent);
  assert.equal(harness.localStorage.getItem("dsh-logcat-serial"), null);
  assert.equal(requests.length, 2);
});

for (const location of [
  { protocol: "https:", hostname: "app" },
  { protocol: "dsh-app:", hostname: "other" },
]) {
  test("does not trust a near-miss desktop origin " + location.protocol + "//" + location.hostname, async t => {
    const requests = [];
    const harness = await mountPanel(t, { ...location, fetch: async (url, options) => {
      requests.push({ url, options });
      return url.endsWith("/mumu/instances") ? readyDiscovery() : connectedResponse();
    } });
    await findConnectButton(harness).props.onClick();
    assert.equal(requests.length, 2);
    for (const { options } of requests) assert.equal(options.headers["x-dsh-logcat-client"], undefined);
  });
}
