# Studio design system

Shared primitives for every Studio screen. Import from the barrel:

```tsx
import { Button, Card, Table, Badge } from "../ui/index.ts";
```

Each primitive is one file, each under 300 lines, styled with plain CSS files
that use the tokens in `tokens.css`.

## Why plain CSS files and not Tailwind / CSS Modules

The visual contract is `mock/index.html` — a hand-written stylesheet with a
finished token system (`--blue`, `--panel`, `--border`, `--shadow`, a full dark
theme under `[data-theme="dark"]`). The cheapest way to stay faithful to it is
to keep those tokens exactly as they are and write component CSS against them.

- **Not Tailwind**: the mock's palette and spacing would have to be re-encoded
  as a Tailwind theme, and every value re-checked against the design. Tailwind
  also puts the styling in the TSX, which makes a 300-line budget harder to
  keep and the diff against the mock harder to read.
- **Not CSS Modules**: they solve name collisions, and we have none. Every class
  is prefixed (`ui-btn`, `ui-card__hd`, `shell__nav`), which gives the same
  isolation with no build-time indirection, and it means a class in devtools has
  the same name as the class in the source.
- Tokens live in `tokens.css` and are imported once by `src/app/App.tsx`. Never
  write a literal colour in a component — use `var(--blue)` etc., or the dark
  theme silently breaks.

## Rules for screen agents

1. **No literal user-visible strings.** Every label, heading, button, empty
   state and error you pass into these components must come from the catalog:
   `const t = useT(); <Button>{t("action.save")}</Button>`. The primitives take
   already-translated strings on purpose — they never call `t` themselves.
2. **Add catalog keys to BOTH `tr.json` and `en.json`** in
   `packages/config/locales/`. Parity is enforced by a test in
   `@maestro/config`, and a missing key throws at render (no silent fallback).
3. **Fetch through `useApi()` + TanStack Query**, never bare `fetch`. See
   "Data fetching" below.
4. **Use the domain tone helpers** (`runStatusTone`, `riskTone`,
   `workModeTone`) so the same status is the same colour on every screen.
5. Keep each screen file under 300 lines; split into `src/screens/<id>/` if it
   grows.

## Components

### Button
```tsx
<Button variant="primary" size="sm" busy={saving} onClick={save}>{t("action.save")}</Button>
```
- `variant`: `"default" | "primary" | "success" | "danger"` (mock `.btn`, `.p`, `.g`, `.d`)
- `size`: `"md" | "sm"`
- `busy`: disables and sets `aria-busy`; use while a mutation is in flight.
- Defaults to `type="button"`, so it never submits a form unless you say so.

### Input / Select
```tsx
<Input label={t("login.username")} value={v} onChange={e => setV(e.target.value)} />
<Input label={t("field.reason")} error={t("error.reject_needs_reason")} />
<Select label={t("shell.language")} value={locale} onChange={...}
        options={[{ value: "tr", label: t("locale.tr") }]} />
```
- `label`, `hint`, `error` are already-translated strings.
- `error` sets `aria-invalid` and replaces the hint. Label and description are
  wired to the control by id, so `getByLabelText` works in tests.

### Card / Kpi
```tsx
<Card title={t("card.attention")} subtitle={t("card.last24h")} actions={<Button size="sm">…</Button>}>
  body
</Card>
<Kpi label={t("kpi.active_flows")} value="12" note={t("kpi.note", { n: "3" })} />
```
- `padded={false}` when the body is a `<Table>` that should run edge to edge.

### Badge
```tsx
<Badge tone={runStatusTone(run.status)}>{t(`run.status.${run.status}`)}</Badge>
```
- `tone`: `blue | green | amber | red | purple | teal | orange | gray`.
- Helpers: `runStatusTone` (covers both BFF status vocabularies — Temporal-level
  `completed/failed/...` and domain-level `gate/fail/done/...`), `riskTone`
  (`dusuk/orta/kritik`), `workModeTone` (`full_auto/ai_assist/human_lead/human_only`).

### Table
```tsx
<Table
  columns={[
    { key: "ticket", header: t("col.ticket"), cell: r => r.ticketKey },
    { key: "status", header: t("col.status"), cell: r => <Badge tone={runStatusTone(r.status)}>…</Badge> },
    { key: "age", header: t("col.age"), cell: r => r.age, align: "right" },
  ]}
  rows={runs}
  rowKey={r => r.runId}
  onRowClick={r => navigate(`/detail/${r.ticketKey}`)}
  loading={isPending}
  emptyLabel={t("empty.no_data")}
/>
```
- Generic over the row type; `cell` is fully typed.
- `rowKey` is required — never key on the array index.
- Renders its own `<Skeleton>` while `loading` and its own `<EmptyState>` when
  `rows` is empty, so list screens need no branching.
- `onRowClick` rows are keyboard-activatable (Enter/Space), not mouse-only.

### Tabs / TabPanel
```tsx
const [tab, setTab] = useState("analysis");
<Tabs label={t("tabs.detail")} active={tab} onChange={setTab}
      items={[{ id: "analysis", label: t("tab.analysis"), count: 3 }]} />
<TabPanel id="analysis" active={tab}>…</TabPanel>
```
Controlled, so you can put the active tab in the URL for deep links.

### Modal
```tsx
<Modal open={open} onClose={close} title={t("modal.confirm")} closeLabel={t("action.close")}
       footer={<><Button onClick={close}>{t("action.cancel")}</Button>
                 <Button variant="danger" onClick={confirm}>{t("action.confirm")}</Button></>}>
  body
</Modal>
```
A real `<dialog>`: focus trapping, Escape and the top layer come from the
platform. Backdrop click closes. Renders nothing while `open` is false.

### Toast
```tsx
const toast = useToast();
toast.show("success", t("toast.saved"));
toast.show("error", t(messageKeyOf(error)));   // never raw server text
```
`tone`: `info | success | warning | error`. Errors persist until dismissed;
everything else auto-dismisses after 6s.

### EmptyState / Skeleton
```tsx
<EmptyState icon="📭" title={t("empty.no_runs")} description={t("empty.no_runs_hint")}
            action={<Button variant="primary">{t("action.create")}</Button>} />
<Skeleton rows={5} />
```

## Data fetching

```tsx
const api = useApi();
const { data, isPending, error } = useQuery({
  queryKey: ["runs", limit],
  queryFn: ({ signal }) => api.get<{ runs: RunSummary[] }>("/runs", { query: { limit }, signal }),
});
```
- Always forward `signal` so a superseded or unmounted query is cancelled.
- Paths are relative to the BFF root (`/runs`, `/params`); the client prefixes
  `/api`, which the dev server proxies to `localhost:7001`.
- On 401 the client clears the session and the app routes to `/login` — you do
  not handle that yourself.
- To show a failure: `t(messageKeyOf(error))` from `src/api/errors.ts`. Never
  render `error.message` or any server string.

## Accessibility

The mock has no focus styles; `tokens.css` adds a `:focus-visible` ring. Keep
interactive things as real `<button>`/`<a>` elements, give icon-only controls an
`aria-label` from the catalog, and prefer these primitives over ad-hoc markup so
the keyboard and screen-reader behaviour stays consistent.
