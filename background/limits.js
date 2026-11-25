// @ts-check

export const MAX_B64 = 16 * 1024 * 1024;

/** @param {number} images */
export const maxOutputTokens = (images) => Math.min(8192, 2500 + 2000 * images);
