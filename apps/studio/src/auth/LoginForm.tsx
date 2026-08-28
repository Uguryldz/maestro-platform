import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { messageKeyOf } from "../api/errors.ts";
import { useI18n, useT } from "../i18n/I18nProvider.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Input } from "../ui/Input.tsx";
import { Select } from "../ui/Select.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { useAuth } from "./AuthProvider.tsx";
import "./LoginForm.css";

interface LocationState {
  readonly from?: string;
}

/**
 * The credential form. Mirrors the mock's `login` view. On success we return
 * the user to wherever RequireSession bounced them from.
 */
export function LoginForm(): ReactNode {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as LocationState | null)?.from ?? "/dash";

  if (status === "authenticated") return <Navigate to={from} replace />;
  // "loading" is NOT "signed out". /login is a PUBLIC route with no guard in
  // front of it, so a cold load that lands here — or is sent here by a guard
  // that has since changed its mind — would otherwise paint a credential form
  // at an operator whose stored token is still being checked. Defence in depth
  // behind the AuthProvider fix: RequireSession draws the same skeleton for the
  // same reason, and the two together mean no code path renders a login prompt
  // on an unresolved session.
  if (status === "loading") return <Skeleton rows={4} />;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorKey(null);
    setBusy(true);
    try {
      await login(username, password);
      void navigate(from, { replace: true });
    } catch (error) {
      // Only a catalog key ever reaches the user; the BFF deliberately answers
      // with a code, and it does not distinguish a wrong password from an
      // unknown account, so neither do we.
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
            <b>{t("app.name")}</b>
            <small>{t("app.tagline")}</small>
          </div>
        </div>

        <Card>
          <form onSubmit={(event) => void onSubmit(event)} className="login__form">
            <Input
              label={t("login.username")}
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
            <Input
              label={t("login.password")}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {errorKey !== null && (
              <p className="login__error" role="alert">
                {t(errorKey)}
              </p>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              {t("login.submit")}
            </Button>
          </form>
        </Card>

        {/* Honest, because there is no self-service reset: accounts are local
            and the platform sends no e-mail. The supported path is the operator
            running reset-admin.sh on the server (deploy bundles), which prints
            a one-time temporary password and forces a change on next login. */}
        <p className="login__forgot">{t("login.forgot")}</p>

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
