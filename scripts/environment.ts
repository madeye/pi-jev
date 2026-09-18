export interface BenchmarkEnvironmentOptions {
  /** Remove every proxy variable so Pi connects to all endpoints directly. */
  direct?: boolean;
}

const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"];

/** Private, CGNAT, and link-local ranges, as bare addresses, prefixes, or CIDR blocks. */
const LAN_ENTRY =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)|\.(local|lan)$/i;

/** Drop LAN exemptions so that traffic reaches the proxy; loopback always stays exempt. */
function bypassList(value: string | undefined): string {
  const kept = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !LAN_ENTRY.test(entry.replace(/^\[|^\*/, "")));
  return [...new Set([...kept, ...LOOPBACK_BYPASS])].join(",");
}

/**
 * Launch Pi with the inherited proxy, routing LAN model traffic through it as well: the
 * local proxy forwards private ranges directly, while a direct connection from Node can be
 * refused by the OS (EHOSTUNREACH). LAN entries are therefore removed from `NO_PROXY`.
 * Set `PI_BENCH_DIRECT=1` (or pass `{ direct: true }`) to strip every proxy variable instead.
 */
export function benchmarkEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: BenchmarkEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const direct = options.direct ?? env.PI_BENCH_DIRECT === "1";
  if (direct) {
    return {
      ...Object.fromEntries(Object.entries(env).filter(([name]) => !/proxy/i.test(name))),
      PI_TELEMETRY: "0",
    };
  }
  const result: NodeJS.ProcessEnv = { ...env, PI_TELEMETRY: "0" };
  const proxied = Object.entries(env).some(
    ([name, value]) => /^(https?|all)_proxy$/i.test(name) && value,
  );
  if (proxied) {
    const bypass = bypassList(env.NO_PROXY ?? env.no_proxy);
    result.NO_PROXY = bypass;
    result.no_proxy = bypass;
  }
  return result;
}
