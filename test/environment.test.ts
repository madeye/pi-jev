import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkEnvironment } from "../scripts/environment.ts";

test("Pi subprocesses have no proxy variables while unrelated settings remain intact", () => {
  const source = {
    HTTP_PROXY: "http://proxy.example:7890",
    https_proxy: "http://proxy.example:7890",
    ALL_PROXY: "socks5://proxy.example:7891",
    NO_PROXY: "localhost",
    no_proxy: "127.0.0.1",
    npm_config_proxy: "http://proxy.example:7890",
    GLOBAL_AGENT_HTTP_PROXY: "http://proxy.example:7890",
    NODE_USE_ENV_PROXY: "1",
    PATH: "/test/bin",
    TYPESAFE_API_KEY: "test-only",
  };
  const env = benchmarkEnvironment(source);
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "PI_TELEMETRY", "TYPESAFE_API_KEY"]);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.TYPESAFE_API_KEY, source.TYPESAFE_API_KEY);
  assert.equal(source.HTTP_PROXY, "http://proxy.example:7890");
});
