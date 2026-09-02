// HTTP entry point: listener/dispatch implementation and route handlers live in
// server/routes, while this stable surface remains the daemon import boundary.
export { GaiaWebServer, startWebServer, type WebServerOptions } from "./routes/runtime.js";
