// Secrets (API keys) for the main process only: <state>/secrets.json, each value encrypted with Electron's
// safeStorage (the OS keyring) when it is available, else stored as is in a file only the user can read.
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export function secretStore(stateDir) {
  const file = path.join(stateDir, "secrets.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; } };
  const enc = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  let cache = null;
  return {
    get(name) {
      cache ||= read();
      const v = cache[name];
      if (!v) return null;
      try { return v.enc ? safeStorage.decryptString(Buffer.from(v.enc, "base64")) : v.plain ?? null; } catch { return null; }
    },
    set(name, value) {
      cache = read();
      if (!value) delete cache[name];
      else cache[name] = enc() ? { enc: safeStorage.encryptString(value).toString("base64") } : { plain: value };
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
