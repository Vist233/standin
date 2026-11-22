// Stands in for dbus-daemon: listens on the socket named by --address=unix:path=... until it is stopped.
import { createServer } from "node:net";

const address = process.argv.find((arg) => arg.startsWith("--address=unix:path="));
const server = createServer((socket) => socket.end());
server.listen(address.slice("--address=unix:path=".length));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
