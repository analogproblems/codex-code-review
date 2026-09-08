export const REVIEW_TIMEOUT_MS = 60 * 60 * 1000;

export async function withReviewTimeout(work, timeoutMs = REVIEW_TIMEOUT_MS, onTimeout = () => {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Review time budget exhausted.");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try { onTimeout(); } catch { /* Preserve the timeout error. */ }
          reject(new Error("Codex review exceeded its time budget (one hour by default); no approval recorded."));
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}
