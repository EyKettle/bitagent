import { createServer } from "node:net";

/** Owns only this fixture's listener and accepted sockets. */
export function socketFixture(onData = () => {}, onPeerClose = () => {}) {
  const peers = new Set();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once("data", onData);
    socket.once("close", () => { peers.delete(socket); onPeerClose(); });
  });
  return {
    server,
    async close() {
      for (const peer of peers) peer.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/** Both owners finish even when target root cleanup rejects. */
export async function closeSocketScope(root, fixture) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => root.close()),
    Promise.resolve().then(() => fixture.close()),
  ]);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Socket fixture cleanup failed");
}
