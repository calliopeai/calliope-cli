import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { createRecorder } from "../scripts/conformance/recorder.mjs";

it("refuses HTTP redirects so one fetch cannot hide a second wire request", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(307, { location: "/redirected" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const recorder = createRecorder(
      globalThis.fetch,
      { protocol: "chat" },
      32,
      AbortSignal.timeout(3000),
    );
    await expect(
      recorder.fetch(`http://127.0.0.1:${port}/start`, {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow();
    expect(requests).toBe(1);
    expect(recorder.exchanges).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("returns live headers before body completion and aborts the actual connection after bytes arrive", async () => {
  let requests = 0;
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_req, res) => {
    requests++;
    res.on("close", closed);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "set-cookie": "private-cookie",
    });
    res.write("data: first live frame\n\n");
    // Intentionally never finish: buffering cannot pass this test.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const controller = new AbortController();
  const recorder = createRecorder(
    globalThis.fetch,
    { protocol: "chat" },
    32,
    AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
    {
      streamResponse: true,
      captureToyRequest: true,
      onChunk() {
        controller.abort(new DOMException("Toy probe cancelled", "AbortError"));
      },
    },
  );
  try {
    const port = (server.address() as { port: number }).port;
    const response = await recorder.fetch(
      `http://127.0.0.1:${port}/v1/chat/completions?key=private-query`,
      {
        method: "POST",
        headers: { authorization: "Bearer private-key" },
        body: '{"messages":[]}',
      },
    );
    expect(controller.signal.aborted).toBe(false);
    expect(recorder.exchanges).toHaveLength(0);
    await expect(response.text()).rejects.toThrow("cancelled");
    await recorder.settled();
    await connectionClosed;
    expect(requests).toBe(1);
    expect(recorder.exchanges).toHaveLength(1);
    const record = recorder.exchanges[0];
    expect(record).toMatchObject({
      complete: false,
      bodyClosed: true,
      status: 200,
    });
    expect(Buffer.from(record.body, "base64").toString()).toBe(
      "data: first live frame\n\n",
    );
    expect(JSON.stringify(record)).not.toContain("private");
    expect(
      JSON.parse(Buffer.from(record.request.body, "base64").toString())
        .max_tokens,
    ).toBe(32);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("records complete streamed bytes and preserves the first HTTP error without retries", async () => {
  const recorder = createRecorder(
    async () => new Response('{"error":{"code":"no_quota"}}', { status: 429 }),
    { protocol: "chat" },
    32,
    undefined,
    { streamResponse: true },
  );
  const response = await recorder.fetch(
    "https://toy.invalid/v1/chat/completions",
    { method: "POST", body: "{}" },
  );
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(await response.json()).toEqual({ error: { code: "no_quota" } });
  await recorder.settled();
  expect(recorder.exchanges[0]).toMatchObject({
    status: 429,
    complete: true,
    bodyClosed: true,
  });
  await expect(
    recorder.fetch("https://toy.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow("request limit");
});

it("bounds live response bytes and cleans up after a consumer stops reading", async () => {
  const make = (bytes: number) =>
    createRecorder(
      async () => new Response(new Uint8Array(bytes)),
      { protocol: "chat" },
      32,
      undefined,
      { streamResponse: true },
    );
  const oversized = make(1024 * 1024 + 1);
  const response = await oversized.fetch("https://toy.invalid/", {
    method: "POST",
    body: "{}",
  });
  await expect(response.text()).rejects.toThrow("1 MiB");
  await oversized.settled();
  expect(oversized.exchanges[0]).toMatchObject({
    complete: false,
    bodyClosed: true,
  });
  const stopped = make(20);
  const body = await stopped.fetch("https://toy.invalid/", {
    method: "POST",
    body: "{}",
  });
  await body.body!.cancel();
  await stopped.settled();
  expect(stopped.exchanges[0]).toMatchObject({
    complete: false,
    bodyClosed: true,
  });
});

it("caps modern Chat Completions requests without adding the incompatible legacy limit field", async () => {
  let sent: any;
  const recorder = createRecorder(
    async (_input: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response("ok");
    },
    { protocol: "chat" },
    64,
  );
  await recorder.fetch("https://toy.invalid/", {
    method: "POST",
    body: '{"max_completion_tokens":512,"messages":[]}',
  });
  expect(sent).toEqual({ max_completion_tokens: 64, messages: [] });
});

it("binds OpenRouter price ceilings to the recorded request and disables server fallback", async () => {
  let sent: any;
  const recorder = createRecorder(
    async (_input: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response("ok");
    },
    { id: "openrouter", protocol: "chat" },
    64,
    undefined,
    { maxPrice: { input: 0.1, output: 0.4 }, captureToyRequest: true },
  );
  await recorder.fetch("https://toy.invalid/", {
    method: "POST",
    body: '{"messages":[]}',
  });
  expect(sent.provider).toEqual({
    allow_fallbacks: false,
    max_price: { input: 0.1, output: 0.4 },
  });
  expect(
    JSON.parse(
      Buffer.from(recorder.exchanges[0].request.body, "base64").toString(),
    ),
  ).toEqual(sent);
});
