/** Launch Pi without inherited proxy settings, as required for direct local-model access. */
export function benchmarkEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !/proxy/i.test(name))),
    PI_TELEMETRY: "0",
  };
}
