import type { PublishReceipt, PublishRequest } from "@maestro/contracts";

/** Publish port (M47 + M103): jira · confluence · repo-docs · docx · pdf. */
export interface PublishPort {
  publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt[]>;
}
