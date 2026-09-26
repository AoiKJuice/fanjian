// Both sides run in the user's browser. No profile or model bytes are sent to a server.
const PRIMARY = "https://aoikjuice.com";
const LEGACY = "https://www.aoikjuice.com";
const DB = "fanjian-local";
const MODEL = "fanjian-model-v1";
const STORES = ["profiles", "ratings", "external_ratings", "collections", "recommendation_runs"];
const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const completed = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("资料迁移中断")); });
async function database() {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore("profiles", { keyPath: "id", autoIncrement: true }).createIndex("updated_at", "updated_at");
    db.createObjectStore("ratings", { keyPath: ["profile_id", "mal_id"] }).createIndex("profile_id", "profile_id");
    db.createObjectStore("external_ratings", { keyPath: ["profile_id", "source", "external_id"] }).createIndex("profile_id", "profile_id");
    db.createObjectStore("collections", { keyPath: ["profile_id", "kind", "mal_id"] }).createIndex("profile_kind", ["profile_id", "kind"]);
    db.createObjectStore("recommendation_runs", { keyPath: "id", autoIncrement: true }).createIndex("profile_id", "profile_id");
  };
  return request(r);
}
async function exportProfiles() {
  const db = await database();
  try {
    const tx = db.transaction(STORES, "readonly");
    const data = Object.fromEntries(await Promise.all(STORES.map(async (name) => [name, await request(tx.objectStore(name).getAll())])));
    data.profiles = data.profiles.filter((profile) => profile.name !== "本地资料"
      || STORES.slice(1).some((name) => data[name].some((row) => row.profile_id === profile.id)));
    return data;
  } finally { db.close(); }
}
async function importProfiles(data, selected) {
  if (!STORES.every((name) => Array.isArray(data?.[name]))) throw new Error("资料格式无效");
  const db = await database();
  try {
    const tx = db.transaction(STORES, "readwrite");
    const done = completed(tx);
    // Attach the rejection handler immediately, including synchronous validation failures.
    done.catch(() => {});
    try {
      const existing = await request(tx.objectStore("profiles").getAll());
      const map = new Map();
      for (const profile of data.profiles) {
        if (!Number.isInteger(profile.id) || typeof profile.name !== "string") throw new Error("资料格式无效");
        const key = `${LEGACY}:${profile.id}:${profile.created_at ?? ""}`;
        const imported = existing.find((p) => p.origin_migration === key);
        if (imported) { map.set(profile.id, imported.id); continue; }
        const { id: sourceId, ...record } = profile;
        const id = await request(tx.objectStore("profiles").add({ ...record, origin_migration: key }));
        map.set(sourceId, id);
        for (const name of STORES.slice(1)) {
          for (const row of data[name].filter((item) => item.profile_id === sourceId)) {
            const copy = { ...row, profile_id: id };
            if (name === "recommendation_runs") delete copy.id;
            await request(tx.objectStore(name).add(copy));
          }
        }
      }
      await done;
      if (!existing.some((p) => p.id === Number(localStorage.getItem("anime-active-profile-id"))) && map.has(Number(selected))) {
        localStorage.setItem("anime-active-profile-id", String(map.get(Number(selected))));
      }
    } catch (error) { try { tx.abort(); } catch {} throw error; }
  } finally { db.close(); }
}
async function fileAt(root, path, create = false) {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) throw new Error("模型路径无效");
  for (const part of parts.slice(0, -1)) root = await root.getDirectoryHandle(part, { create });
  return root.getFileHandle(parts.at(-1), { create });
}
async function readJson(root, path) {
  try { return JSON.parse(await (await (await fileAt(root, path)).getFile()).text()); }
  catch (error) { if (error.name === "NotFoundError") return null; throw error; }
}
async function writeJson(root, path, value) {
  const writer = await (await fileAt(root, path, true)).createWritable();
  try { await writer.write(JSON.stringify(value)); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
}
const records = (entry) => [entry.manifest.browser_catalog, ...entry.manifest.files];
const pathFor = (entry, record) => [entry.directory, record.path].filter(Boolean).join("/");
async function modelEntries(root) {
  const entries = await readJson(root, "versions.json") ?? {};
  const installed = await readJson(root, "installed.json");
  const catalog = await readJson(root, ".catalog-installed.json");
  for (const manifest of [installed, catalog]) {
    if (manifest && !entries[manifest.model_version]) entries[manifest.model_version] = {
      manifest, directory: "", installed: installed?.model_version === manifest.model_version, verified: {},
    };
  }
  for (const entry of Object.values(entries)) {
    entry.bytes = 0;
    entry.sizes = {};
    for (const record of records(entry)) {
      try {
        const size = (await (await fileAt(root, pathFor(entry, record))).getFile()).size;
        if (size <= record.bytes) { entry.sizes[record.path] = size; entry.bytes += size; }
      } catch (error) { if (error.name !== "NotFoundError") throw error; }
    }
  }
  return { entries, active: installed?.model_version };
}
async function withModelsLocked(action) {
  return navigator.locks.request("fanjian-model-download", { ifAvailable: true }, async (lease) => {
    if (!lease) throw new Error("请暂停其他页面的模型下载后重试");
    return navigator.locks.request("fanjian-model-selection", action);
  });
}
async function receive(port) {
  let root, source, pending = [], release;
  let queue = Promise.resolve();
  let timer;
  const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => { release?.(); port.close(); }, 120_000); };
  port.onmessage = ({ data }) => {
    queue = queue.then(async () => {
      resetTimer();
      try {
        let result;
        if (data.action === "start") {
          if (source) throw new Error("迁移已经开始");
          // Keep downloads and model selection paused in the destination until commit.
          await new Promise((resolve, reject) => {
            withModelsLocked(async () => {
              await new Promise((done) => { release = done; resolve(); });
            }).catch(reject);
          });
          await importProfiles(data.profiles, data.selected);
          await navigator.storage.persist?.();
          root = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODEL, { create: true });
          source = data.models;
          const target = await modelEntries(root);
          pending = Object.entries(source.entries).filter(([version, entry]) => {
            const current = target.entries[version];
            return entry.bytes > 0 && (!current || (!current.installed && entry.bytes > current.bytes));
          }).map(([version]) => version);
          result = pending;
        } else if (data.action === "file") {
          if (!pending.includes(data.version)) throw new Error("未请求此模型版本");
          const entry = source.entries[data.version];
          const record = records(entry).find((r) => r.path === data.path);
          if (!record || !(data.file instanceof Blob) || data.file.size !== entry.sizes[record.path]) throw new Error("模型文件无效");
          const path = `imports/www/${encodeURIComponent(data.version)}/${record.path}`;
          const handle = await fileAt(root, path, true);
          if ((await handle.getFile()).size !== data.file.size) {
            const writer = await handle.createWritable();
            try { await writer.write(data.file); await writer.close(); }
            catch (error) { await writer.abort().catch(() => {}); throw error; }
          }
        } else if (data.action === "finish") {
          if (!source) throw new Error("迁移尚未开始");
          await navigator.locks.request("fanjian-model-metadata", async () => {
            const target = await modelEntries(root);
            for (const version of pending) {
              const from = source.entries[version];
              const entry = { manifest: from.manifest, directory: `imports/www/${encodeURIComponent(version)}`, installed: from.installed, verified: from.verified ?? {} };
              for (const record of records(entry)) {
                const size = from.sizes[record.path] ?? 0;
                if (size > 0 && (await (await fileAt(root, pathFor(entry, record))).getFile()).size !== size) throw new Error("模型迁移尚未完成");
                if (size !== record.bytes) entry.installed = false;
              }
              target.entries[version] = entry;
            }
            await writeJson(root, "versions.json", target.entries);
            if (!target.active && source.active && target.entries[source.active]?.installed) {
              await writeJson(root, "installed.json", target.entries[source.active].manifest);
            }
          });
          release?.(); clearTimeout(timer);
        } else throw new Error("迁移请求无效");
        port.postMessage({ id: data.id, result });
      } catch (error) {
        release?.(); clearTimeout(timer);
        port.postMessage({ id: data.id, error: error.message ?? "资料迁移失败" });
      }
    });
  };
  port.start(); resetTimer();
}
async function migrate() {
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const base = new URL(import.meta.url).pathname.replace(/\/origin-migration\.js$/, "");
  const destination = PRIMARY + location.pathname + location.search + location.hash;
  await withModelsLocked(async () => {
    await navigator.storage.persist?.();
    const profiles = await exportProfiles();
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODEL, { create: true });
    const models = await modelEntries(root);
    if (!profiles.profiles.length && !Object.values(models.entries).some((e) => e.bytes > 0)) { location.replace(destination); return; }
    status.textContent = "正在迁移本地资料";
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = `${PRIMARY}${base}/origin-bridge.html`;
    const channel = new MessageChannel();
    let serial = 0;
    const calls = new Map();
    channel.port1.onmessage = ({ data }) => {
      const call = calls.get(data.id);
      if (!call) return;
      clearTimeout(call.timer); calls.delete(data.id);
      if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
    };
    const call = (action, fields = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { calls.delete(id); reject(new Error("迁移连接超时，请重试")); }, 120_000);
      calls.set(id, { resolve, reject, timer });
      channel.port1.postMessage({ id, action, ...fields });
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener("message", ready); reject(new Error("无法打开统一地址，请重试")); }, 30_000);
        const ready = (event) => {
          if (event.origin !== PRIMARY || event.source !== iframe.contentWindow || event.data !== "fanjian-origin-ready") return;
          clearTimeout(timer); window.removeEventListener("message", ready);
          iframe.contentWindow.postMessage("fanjian-origin-connect", PRIMARY, [channel.port2]); resolve();
        };
        window.addEventListener("message", ready); document.body.append(iframe);
      });
      const versions = await call("start", { profiles, selected: localStorage.getItem("anime-active-profile-id"), models });
      progress.max = versions.reduce((sum, version) => sum + models.entries[version].bytes, 0);
      progress.value = 0; progress.hidden = !versions.length;
      for (const version of versions) {
        status.textContent = "正在迁移本地模型";
        const entry = models.entries[version];
        for (const record of records(entry)) {
          if (!entry.sizes[record.path]) continue;
          const file = await (await fileAt(root, pathFor(entry, record))).getFile();
          await call("file", { version, path: record.path, file });
          progress.value += file.size;
        }
      }
      await call("finish");
      location.replace(destination);
    } finally { iframe.remove(); channel.port1.close(); for (const pending of calls.values()) clearTimeout(pending.timer); }
  });
}
if (location.origin === PRIMARY && location.pathname.endsWith("/origin-bridge.html") && window.parent !== window) {
  window.addEventListener("message", (event) => {
    if (event.origin !== LEGACY || event.source !== window.parent || event.data !== "fanjian-origin-connect" || event.ports.length !== 1) return;
    void receive(event.ports[0]);
  });
  window.parent.postMessage("fanjian-origin-ready", LEGACY);
} else if (location.origin === LEGACY && document.getElementById("status")) {
  document.getElementById("retry").onclick = () => location.reload();
  migrate().catch((error) => {
    document.getElementById("status").textContent = "资料迁移未完成";
    document.getElementById("error").textContent = error.message ?? "资料迁移失败";
    document.getElementById("error").hidden = false;
    document.getElementById("retry").hidden = false;
  });
}
