import { describe, expect, it } from "vitest";
import {
  ApplicationRecord,
  AuditAction,
  BindingState,
  DataClass,
  JournalActor,
  JournalKind,
  LlmRole,
  ParamScope,
  ParamType,
  RiskTier,
  StepKind,
  SubscriptionAccountState,
  TriggerMode,
  WorkflowRunStatus,
  WorkMode,
} from "@maestro/contracts";
import { parseDateTimeFields, parseEnums, parseModels, parseNativeTypes } from "../src/index.js";
import { readSchema } from "./paths.js";

/**
 * The physical enum types in Postgres must be exactly the contract options —
 * same values, same order-independent set, no `@map` aliases. Every enum in
 * the schema needs an entry here, so adding one without a contract twin is a
 * test failure rather than a silent divergence.
 */
const ENUM_MIRRORS: Record<string, readonly string[]> = {
  RunStatus: WorkflowRunStatus.options,
  WorkModeE: WorkMode.options,
  RiskTierE: RiskTier.options,
  DataClassE: DataClass.options,
  BindingStateE: BindingState.options,
  TriggerModeE: TriggerMode.options,
  ParamScopeE: ParamScope.options,
  ParamTypeE: ParamType.options,
  JournalActorE: JournalActor.options,
  JournalKindE: JournalKind.options,
  AuditActionE: AuditAction.options,
  LlmRoleE: LlmRole.options,
  SubscriptionStateE: SubscriptionAccountState.options,
  StepKindE: StepKind.options,
  // `createdVia` has no standalone contract enum; the shape inside
  // `ApplicationRecord` is the source, so the mirror still cannot drift.
  CreatedViaE: ApplicationRecord.shape.createdVia.options,
};

const schema = readSchema();
const schemaEnums = parseEnums(schema);

describe("schema enums mirror @maestro/contracts", () => {
  it("parses every enum block", () => {
    expect(schemaEnums.length).toBe(Object.keys(ENUM_MIRRORS).length);
  });

  it("has no unmapped enum", () => {
    const unmapped = schemaEnums.map((e) => e.name).filter((n) => ENUM_MIRRORS[n] === undefined);
    expect(unmapped).toEqual([]);
  });

  for (const [name, options] of Object.entries(ENUM_MIRRORS)) {
    it(`${name} matches its contract enum exactly`, () => {
      const parsed = schemaEnums.find((e) => e.name === name);
      expect(parsed, `enum ${name} missing from schema.prisma`).toBeDefined();
      expect(parsed?.values).toEqual([...options]);
    });
  }

  it("never aliases an enum member with @map (client values must equal contract values)", () => {
    for (const line of schema.split("\n")) {
      expect(line).not.toMatch(/^\s+\w+\s+@map\(/);
    }
  });
});

describe("schema conventions", () => {
  it("stores every timestamp as timestamptz(3)", () => {
    const offenders = parseDateTimeFields(schema).filter((f) => f.native !== "Timestamptz(3)");
    expect(offenders).toEqual([]);
  });

  it("uses Decimal, never Float, for money", () => {
    expect(schema).toMatch(/usd\s+Decimal\?\s+@db\.Decimal\(12, 6\)/);
  });

  it("declares the postgresql datasource driven by DATABASE_URL", () => {
    expect(schema).toMatch(/provider\s*=\s*"postgresql"/);
    expect(schema).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
  });

  it("keeps every relation restrict-on-delete (retention, M30/M56)", () => {
    const relations = schema.match(/@relation\([^)]*\)/g) ?? [];
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) {
      expect(relation).toContain("onDelete: Restrict");
    }
  });

  it("only uses native types we have reviewed", () => {
    expect(parseNativeTypes(schema)).toEqual(["Decimal", "Timestamptz", "VarChar"]);
  });
});

describe("schema-facts parsers", () => {
  const fixture = `
/// SomeContract
enum Colour {
  red
  green // trailing comment
}

model Thing {
  id     String   @id @db.VarChar(8)
  madeAt DateTime @db.Timestamptz(3)
  seenAt DateTime?

  @@map("things")
}
`;

  it("reads enum values and the doc line", () => {
    expect(parseEnums(fixture)).toEqual([
      { name: "Colour", values: ["red", "green"], doc: "SomeContract" },
    ]);
  });

  it("resolves @@map to the physical table name", () => {
    expect(parseModels(fixture)).toEqual([{ name: "Thing", tableName: "things" }]);
  });

  it("reports DateTime fields with and without a native type", () => {
    expect(parseDateTimeFields(fixture)).toEqual([
      { model: "Thing", field: "madeAt", native: "Timestamptz(3)" },
      { model: "Thing", field: "seenAt", native: null },
    ]);
  });

  it("collects native types", () => {
    expect(parseNativeTypes(fixture)).toEqual(["Timestamptz", "VarChar"]);
  });
});
