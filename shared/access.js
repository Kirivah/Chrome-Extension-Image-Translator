// @ts-check

export const ALL = ['<all_urls>'];

const WAIT_MS = 4000;

/**
 * @param {number} [wait]
 * @returns {Promise<string>}
 */
export function requestAccess(wait = WAIT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('The browser showed no permission prompt.'), wait);
    let asked;
    try {
      asked = chrome.permissions.request({ origins: ALL });
    } catch (e) {
      clearTimeout(timer);
      resolve(String(/** @type {Error} */ (e)?.message ?? e) || 'The browser refused the request.');
      return;
    }
    Promise.resolve(asked).then(
      (granted) => { clearTimeout(timer); resolve(granted ? '' : 'Access wasn’t granted.'); },
      (e) => { clearTimeout(timer); resolve(String(e?.message ?? e) || 'The browser refused the request.'); },
    );
  });
}

export const ACCESS_HELP = 'Some browsers, on phones especially, can’t show this prompt. '
  + 'Allow it in the browser instead: open its Extensions page, find Image Translator, and let it run on all sites. '
  + 'Or remove the extension and install it again: it asks for this access when it’s installed.';
