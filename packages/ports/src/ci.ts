import type { CiResultSignal } from "@maestro/contracts";

/** A CI webhook delivery: headers carry the authentication, body the event. */
export interface CiWebhookRequest {
  headers: Record<string, string>;
  /** The RAW, unparsed delivery body — authentication is checked against it. */
  body: unknown;
}

/**
 * CI port is PASSIVE (M12): CI runs under ADO branch policy; Maestro only
 * parses Service Hook events into workflow signals.
 */
export interface CiPort {
  /**
   * Authenticate the delivery, then parse it. Takes the whole request so a
   * caller cannot parse an unauthenticated body — "no header" must never
   * mean "no authentication required". Throws on failed authentication;
   * returns null for deliveries that are not build results.
   */
  parseBuildEvent(request: CiWebhookRequest): Promise<CiResultSignal | null>;
}
