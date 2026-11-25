// @ts-check
export class JsonObjectStream {
  /** @param {(obj: unknown) => void} onObject */
  constructor(onObject) {
    this.onObject = onObject;
    this.text = '';
    this.pos = 0;
    /** @type {string[]} */
    this.stack = [];
    this.inStr = false;
    this.esc = false;
    this.start = -1;
    this.emitted = 0;
    this.clean = true;
    this.complete = false;
    this.extra = 0;
  }

  /** @param {string} chunk */
  push(chunk) {
    if (!chunk) return;
    if (this.complete) { this.extra += chunk.length; return; }
    this.text += chunk;
    const s = this.text;
    for (let i = this.pos; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === 92) this.esc = true;
        else if (c === 34) this.inStr = false;
        continue;
      }
      if (this.stack.length === 0 && c !== 123 && c !== 91 && c !== 32 && c !== 10 && c !== 13 && c !== 9) {
        this.clean = false;
      }
      if (c === 34) { this.inStr = true; continue; }
      if (c === 123) {
        const parent = this.stack[this.stack.length - 1];
        if (parent === '[' && this.stack.length <= 2 && this.start < 0) this.start = i;
        this.stack.push('{');
      } else if (c === 91) {
        this.stack.push('[');
      } else if (c === 125 || c === 93) {
        const top = this.stack.pop();
        if (top !== (c === 125 ? '{' : '[')) this.clean = false;
        if (c === 125 && this.start >= 0 && this.stack[this.stack.length - 1] === '[' && this.stack.length <= 2) {
          const slice = s.slice(this.start, i + 1);
          this.start = -1;
          try {
            this.onObject(JSON.parse(slice));
            this.emitted++;
          } catch {}
        }
        if (this.clean && this.stack.length === 0) {
          this.complete = true;
          this.extra = s.length - i - 1;
          this.text = s.slice(0, i + 1);
          this.pos = this.text.length;
          return;
        }
      }
    }
    this.pos = s.length;
  }

  get value() {
    return this.text;
  }
}
