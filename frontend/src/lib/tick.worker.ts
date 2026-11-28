/**
 * A clock that keeps time while the page is in the background. Browsers slow
 * a hidden page's own timers down to once a minute after a while; a worker's
 * are left alone. Posts a message every `ms` milliseconds until told to stop.
 */
let timer: ReturnType<typeof setInterval> | null = null;
self.onmessage = (e: MessageEvent<{ start?: number; stop?: true }>) => {
  if (timer != null) clearInterval(timer);
  timer = null;
  if (e.data.start) timer = setInterval(() => self.postMessage(0), e.data.start);
};
