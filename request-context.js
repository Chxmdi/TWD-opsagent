import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function withActor(actor, fn) {
  return storage.run({ actor: actor || "system" }, fn);
}

export function currentActor() {
  return storage.getStore()?.actor || "system";
}
