// @ts-check
let holders = 0;
/** @type {ReturnType<typeof setInterval> | 0} */
let timer = 0;

export function hold() {
  if (holders++ === 0) {
    timer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20_000);
  }
}

export function release() {
  if (holders > 0 && --holders === 0 && timer) {
    clearInterval(timer);
    timer = 0;
  }
}
