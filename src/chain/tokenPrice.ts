import type { FastifyBaseLogger } from "fastify";

/** Zero address: the Superfluid token-prices API's key for a chain's native token. */
export const NATIVE_TOKEN_PRICE_ADDRESS = "0x0000000000000000000000000000000000000000";

export const DEFAULT_TOKEN_PRICE_API_URL = "https://token-prices-api.superfluid.dev";

export type TokenPriceClientOptions = {
  /** Base URL of the token-prices API (trailing slashes are ignored). */
  baseUrl?: string | undefined;
  /** Per-request timeout. */
  timeoutMs?: number | undefined;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch | undefined;
  logger?: Pick<FastifyBaseLogger, "warn"> | undefined;
};

/**
 * Looks up USD token prices from the Superfluid token-prices API (the same source
 * observability-tools/balance-watcher uses). No caching: the balance sampler polls hourly,
 * and Prometheus gauges already retain their last value when a fetch fails.
 */
export class TokenPriceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<FastifyBaseLogger, "warn"> | undefined;

  constructor(options: TokenPriceClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_TOKEN_PRICE_API_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = options.logger;
  }

  /** USD price of one whole token, or null when the API is unavailable or answers with an invalid payload. */
  async getPrice(network: string, address: string): Promise<number | null> {
    const url = `${this.baseUrl}/v1/${network}/${address}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        const detail = typeof body.error === "string" ? body.error : response.statusText;
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      const payload = (await response.json()) as { price?: unknown };
      const price = typeof payload.price === "string" ? Number(payload.price) : payload.price;
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
        throw new Error(`invalid price payload: ${JSON.stringify(payload).slice(0, 200)}`);
      }
      return price;
    } catch (error) {
      this.logger?.warn({ err: error, network, address }, "token price fetch failed");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Price of the native gas token for a Superfluid network slug. */
  getNativePrice(network: string): Promise<number | null> {
    return this.getPrice(network, NATIVE_TOKEN_PRICE_ADDRESS);
  }
}
