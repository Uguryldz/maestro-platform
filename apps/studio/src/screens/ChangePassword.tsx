import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError } from "../api/errors.ts";
import { messageKeyOf } from "../api/errors.ts";
import { useAuth } from "../auth/AuthProvider.tsx";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Input } from "../ui/Input.tsx";
import { Select } from "../ui/Select.tsx";
import "../auth/LoginForm.css";

/** The failed password rules the BFF returns in `password_policy.details`. */
type PasswordViolation =
  | "too_short"
  | "too_long"
  | "no_upper"
  | "no_lower"
  | "no_digit"
  | "no_symbol"
  | "contains_username";

/**
 * The first-run bootstrap change-password screen (banking standard).
 *
 * Rendered outside the shell, standing alone: RequireSession routes a session
 * whose `mustChangePassword` is true here and lets it reach nothing else, and
 * the BFF backs that up (a restricted token meets 409 everywhere but here,
 * logout and session). The user cannot get into the app until they set a
 * policy-compliant password.
 *
 * The new password faces the FULL M8 policy server-side — `admin123` is refused
 * (too short, no symbol) — and the violations come back per-rule, shown inline
 * in the operator's language. On success the BFF has killed every session of
 * the account, so the auth provider clears the local session and the user lands
 * on /login to sign in with the new password.
 */
export function ChangePasswordScreen(): ReactNode {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { changePassword } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [violations, setViolations] = useState<readonly PasswordViolation[]>([]);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = next !== "" && repeat !== "" && next !== repeat;
  const blocked = current === "" || next === "" || repeat === "" || mismatch;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorKey(null);
    setViolations([]);
    if (blocked) {
      if (mismatch) setErrorKey("login.change.error.mismatch");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      // On success the provider clears the session; RequireSession takes the
      // user to /login, where they sign in with the new password.
    } catch (error) {
      if (error instanceof ApiError && error.code === "password_policy") {
        setViolations(readViolations(error.details));
        return;
      }
      if (error instanceof ApiError && error.code === "invalid_credentials") {
        setErrorKey("login.change.error.wrong_current");
        return;
      }
      if (error instanceof ApiError && error.code === "password_change_unavailable") {
        setErrorKey("login.change.unavailable");
        return;
      }
      setErrorKey(messageKeyOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login__box">
        <div className="login__brand">
          <span className="login__logo">M</span>
          <div>
            <b>{t("login.change.title")}</b>
            <small>{t("login.change.subtitle")}</small>
          </div>
        </div>

        <Card>
          <form onSubmit={(event) => void onSubmit(event)} className="login__form">
            <Input
              label={t("login.change.current")}
              name="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
            <Input
              label={t("login.change.new")}
              name="new-password"
              type="password"
              autoComplete="new-password"
              hint={t("login.change.hint")}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
            <Input
              label={t("login.change.repeat")}
              name="repeat-password"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              {...(mismatch ? { error: t("login.change.error.mismatch") } : {})}
              required
            />

            {violations.length > 0 && (
              <div className="login__error" role="alert">
                <div>{t("users.error.password_policy")}</div>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {violations.map((rule) => (
                    <li key={rule}>{t(`users.password.${rule}`)}</li>
                  ))}
                </ul>
              </div>
            )}
            {errorKey !== null && (
              <p className="login__error" role="alert">
                {t(errorKey)}
              </p>
            )}

            <Button type="submit" variant="primary" busy={busy}>
              {t("login.change.submit")}
            </Button>
          </form>
        </Card>

        <div className="login__lang">
          <Select
            label={t("shell.language")}
            value={locale}
            onChange={(event) => setLocale(event.target.value === "en" ? "en" : "tr")}
            options={[
              { value: "tr", label: t("locale.tr") },
              { value: "en", label: t("locale.en") },
            ]}
          />
        </div>
      </div>
    </main>
  );
}

function readViolations(details: unknown): readonly PasswordViolation[] {
  if (typeof details !== "object" || details === null) return [];
  const value = (details as { violations?: unknown }).violations;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PasswordViolation => typeof entry === "string");
}
