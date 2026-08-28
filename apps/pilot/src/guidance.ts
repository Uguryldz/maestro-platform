/**
 * The pilot's ANALYSIS GUIDANCE — the enabled "öğren" notes, mirrored from the
 * DB over the BFF proxy (same pattern as listening rules). The analyst reads
 * these when preparing a NEW analysis, so an operator's uploaded knowledge is
 * taken into account ("yeni analiz hazırlarken dikkat edilecekler").
 *
 * The pilot is DB-free, so this in-memory store IS the pilot's copy; the BFF
 * pushes the full enabled set whenever it changes. A note is `{ title, content }`
 * — exactly the `NamedDoc` shape the agent-roles KnowledgePack expects.
 */
export interface GuidanceNote {
  title: string;
  content: string;
  /**
   * Ajan hedefi: ABSENT = herkese (her ajanın bağlamına girer — eski davranış);
   * dolu = yalnız bu variant'ın koştuğu rolde bağlama girer (ajan detayından
   * yüklenen belgeler böyle hedeflenir).
   */
  variantId?: string;
}

export class GuidanceStore {
  private notes: readonly GuidanceNote[] = [];

  constructor(initial: readonly GuidanceNote[] = []) {
    this.set(initial);
  }

  /** Replace the whole set (the BFF mirror sends the full enabled list). */
  set(notes: readonly GuidanceNote[]): void {
    this.notes = notes
      .filter((n): n is GuidanceNote =>
        typeof n?.title === "string" && n.title.trim().length > 0 &&
        typeof n?.content === "string" && n.content.trim().length > 0,
      )
      .map((n) => {
        const variantId =
          typeof (n as { variantId?: unknown }).variantId === "string" &&
          (n as { variantId: string }).variantId.trim() !== ""
            ? (n as { variantId: string }).variantId.trim()
            : undefined;
        return {
          title: n.title.trim(),
          content: n.content.trim(),
          ...(variantId !== undefined ? { variantId } : {}),
        };
      });
  }

  snapshot(): readonly GuidanceNote[] {
    return this.notes;
  }

  /**
   * The notes ONE agent should see: every global note (no target) plus the
   * notes targeted at exactly this variant. `null` variant (no run-time agent
   * resolved) sees only the global set — a targeted note never leaks to an
   * agent it was not written for.
   */
  forVariant(variantId: string | null): readonly GuidanceNote[] {
    return this.notes.filter((n) => n.variantId === undefined || n.variantId === (variantId ?? ""));
  }
}
