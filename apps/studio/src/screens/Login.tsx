import type { ReactNode } from "react";
import { LoginForm } from "../auth/LoginForm.tsx";

/**
 * Screen: login. Rendered outside the shell (no sidebar, no session).
 * The working credential form lives in src/auth/LoginForm.tsx — a screen agent
 * polishing this page should edit that component or wrap it here.
 */
export function LoginScreen(): ReactNode {
  return <LoginForm />;
}
