// Hopp's public address: passes every request (WebSockets included) to hopp-cloud.

interface Env {
  CLOUD: Fetcher;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.CLOUD.fetch(request);
  },
} satisfies ExportedHandler<Env>;
