import type { FakeCdpCommand, FakeOptions } from "./fakeCdpBrowserTypes.js";

type FakeEvent = NonNullable<
  ReturnType<NonNullable<FakeOptions["commandEvents"]>>
>[number];

/** One network request as Chrome reports it before any body read. */
export interface FakeStreamRequest {
  readonly requestId: string;
  readonly path: string;
  readonly mimeType: string;
  /** CDP resource type; EventSource requests report `EventSource`. */
  readonly type?: string;
  /** False keeps the response open: no `Network.loadingFinished` is sent. */
  readonly finished?: boolean;
  readonly origin?: string;
}

const session = (command: FakeCdpCommand) =>
  command.sessionId === undefined ? {} : { sessionId: command.sessionId };

/** Producer-shaped request, response, and optional completion events. */
export const streamRequestEvents = (
  command: FakeCdpCommand,
  origin: string,
  request: FakeStreamRequest,
): FakeEvent[] => {
  const url = `${request.origin ?? origin}${request.path}`;
  return [
    {
      ...session(command),
      method: "Network.requestWillBeSent",
      params: {
        requestId: request.requestId,
        type: request.type ?? "Fetch",
        request: { url, method: "GET" },
        initiator: { type: "script" },
      },
    },
    {
      ...session(command),
      method: "Network.responseReceived",
      params: {
        requestId: request.requestId,
        response: { url, status: 200, mimeType: request.mimeType, headers: {} },
      },
    },
    ...(request.finished === false
      ? []
      : [
          {
            ...session(command),
            method: "Network.loadingFinished",
            params: { requestId: request.requestId, encodedDataLength: 64 },
          },
        ]),
  ];
};

/** A `Network.eventSourceMessageReceived` event; params may be malformed on purpose. */
export const eventSourceMessage = (
  command: FakeCdpCommand,
  params: Readonly<Record<string, unknown>>,
): FakeEvent => ({
  ...session(command),
  method: "Network.eventSourceMessageReceived",
  params: { timestamp: 1, ...params },
});
