import { randomBytes } from "node:crypto";
import type { GuidanceRecord, GuidanceStore, GuidanceWrite } from "@maestro/bff";

/**
 * The Postgres-backed `GuidanceStore` — the "öğren" knowledge library
 * (Bilgi kütüphanesi, migration 0014). Notes an operator uploads must survive a
 * restart the same way connections and rules do, so this reads/writes the
 * `AnalysisGuidance` table. The delegate is structural, like every other store
 * here, so `apps/bff` never depends on the generated client.
 */
export interface GuidanceRow {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  /** Ajan hedefi (migration 0016): NULL = global; dolu = yalnız o variant. */
  variantId?: string | null;
  updatedAt: Date;
}

export interface GuidanceDelegate {
  findMany(args: {
    where?: { enabled?: boolean };
    orderBy: { updatedAt: "desc" };
  }): Promise<GuidanceRow[]>;
  create(args: { data: GuidanceRow }): Promise<GuidanceRow>;
  update(args: { where: { id: string }; data: Partial<Omit<GuidanceRow, "id">> }): Promise<GuidanceRow>;
  delete(args: { where: { id: string } }): Promise<GuidanceRow>;
}

export class PrismaGuidanceStore implements GuidanceStore {
  constructor(private readonly rows: GuidanceDelegate) {}

  async list(): Promise<readonly GuidanceRecord[]> {
    const rows = await this.rows.findMany({ orderBy: { updatedAt: "desc" } });
    return rows.map(toRecord);
  }

  async listEnabled(): Promise<readonly GuidanceRecord[]> {
    const rows = await this.rows.findMany({ where: { enabled: true }, orderBy: { updatedAt: "desc" } });
    return rows.map(toRecord);
  }

  async create(write: GuidanceWrite): Promise<GuidanceRecord> {
    const row = await this.rows.create({
      data: { id: `ag_${randomBytes(9).toString("hex")}`, ...write, updatedAt: new Date() },
    });
    return toRecord(row);
  }

  async update(id: string, patch: Partial<GuidanceWrite>): Promise<GuidanceRecord | null> {
    try {
      const row = await this.rows.update({ where: { id }, data: { ...patch, updatedAt: new Date() } });
      return toRecord(row);
    } catch {
      // `update` throws when the row is absent — that is the contract's "null".
      return null;
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.rows.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }
}

function toRecord(row: GuidanceRow): GuidanceRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    enabled: row.enabled,
    // Yazma yolu `...write` spread'iyle zaten DB'ye geçiyordu; okuma yolu bu
    // eşleme olmadan hedefi DÜŞÜRÜYORDU — ajan-hedefli not global görünürdü.
    variantId: row.variantId ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
