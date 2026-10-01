export class GameplayEvents {
  constructor() {
    this.listeners = new Map();
  }

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(type);
    };
  }

  emit(type, detail = {}) {
    const event = Object.freeze({ type, ...detail });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    for (const listener of this.listeners.get("*") ?? []) listener(event);
    return event;
  }

  clear() {
    this.listeners.clear();
  }
}