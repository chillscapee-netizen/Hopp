/**
 * What to tell people when something fails inside Hopp Cloud. Past Cloudflare's free
 * daily limits, storage and calls start failing; that gets a plain, calm explanation.
 */
export function troubleMessage(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  console.error("cloud error:", text);
  if (/exceeded|limit|quota|too many/i.test(text)) {
    return "Hopp Cloud is overloaded right now. It usually comes back within a few hours. Your messages and servers are safe.";
  }
  return "Something went wrong on Hopp Cloud. Try again in a moment.";
}
