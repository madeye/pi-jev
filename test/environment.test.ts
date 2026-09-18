import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkEnvironment } from "../scripts/environment.ts";

test("direct mode removes every proxy variable while unrelated settings remain intact", () => {
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
  const env = benchmarkEnvironment(source, { direct: true });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "PI_TELEMETRY", "TYPESAFE_API_KEY"]);
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.TYPESAFE_API_KEY, source.TYPESAFE_API_KEY);
  assert.equal(source.HTTP_PROXY, "http://proxy.example:7890");
});

test("LAN traffic is sent through the inherited proxy while loopback stays exempt", () => {
  const source = {
    HTTPS_PROXY: "http://127.0.0.1:7890",
    HTTP_PROXY: "http://127.0.0.1:7890",
    NO_PROXY: "localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.4,*.local,example.com,172.64.0.1",
    PATH: "/test/bin",
  };
  const env = benchmarkEnvironment(source);
  assert.equal(env.HTTPS_PROXY, source.HTTPS_PROXY);
  assert.equal(env.HTTP_PROXY, source.HTTP_PROXY);
  assert.equal(env.NO_PROXY, "localhost,example.com,172.64.0.1,127.0.0.1,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.PATH, source.PATH);
  assert.equal(source.NO_PROXY.includes("192.168.0.4"), true);
});

test("PI_BENCH_DIRECT=1 selects direct mode and no bypass list is invented without a proxy", () => {
  const direct = benchmarkEnvironment({
    HTTP_PROXY: "http://127.0.0.1:7890",
    PI_BENCH_DIRECT: "1",
  });
  assert.deepEqual(Object.keys(direct), ["PI_BENCH_DIRECT", "PI_TELEMETRY"]);
  const plain = benchmarkEnvironment({ PATH: "/test/bin" });
  assert.deepEqual(Object.keys(plain).sort(), ["PATH", "PI_TELEMETRY"]);
});
