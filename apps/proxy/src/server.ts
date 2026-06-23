import { buildProxyServer } from "./app.js";
import { loadProxyConfig } from "./config.js";
import { assertBigIntJsonRuntime } from "./convexJson.js";
import { openDeltasStore } from "./store.js";

assertBigIntJsonRuntime();

const config = loadProxyConfig();
const store = openDeltasStore(config.dataDir);

const app = buildProxyServer({
  store,
  pageSize: config.pageSize,
  bearerToken: config.dataBearerToken,
  convex: {
    baseUrl: config.convexBaseUrl,
    deployKey: config.convexDeployKey,
  },
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { dataDir: config.dataDir, pageSize: config.pageSize },
    "Convex DuckDB mirror HTTP server started",
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
