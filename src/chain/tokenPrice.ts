import type { FastifyBaseLogger } from "fastify";

export const NATIVE_TOKEN_PRICE_ADDRESS = "0x0000000000000000000000000000000000000000";

export const DEFAULT_TOKEN_PRICE_API_URL = "https://token-prices-api.superfluid.dev";

export type TokenPriceClientOptions = {
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  logger?: Pick<FastifyBaseLogger, "warn"> | undefined;
};

/** Looks up USD token prices from the Superfluid token-prices API. */
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

  /** USD price of one whole token, or null when unavailable. */
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

  getNativePrice(network: string): Promise<number | null> {
    return this.getPrice(network, NATIVE_TOKEN_PRICE_ADDRESS);
  }
}
