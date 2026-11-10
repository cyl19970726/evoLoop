// Shows the questions askConfirm() queues (shared/confirm.ts), one at a time, in @evoloop/ui's ConfirmDialog.
// App mounts it after login; it loads on demand so the login page stays free of the design system's scripts. While it
// is mounted the questions can be answered; when it leaves the page (signing out) they are answered with "cancel".
import * as React from "react";
import { ConfirmDialog } from "@evoloop/ui";
import { answerConfirm, confirmHostMounted, currentConfirm, subscribeConfirm } from "../confirm";

export function ConfirmHost() {
  const request = React.useSyncExternalStore(subscribeConfirm, currentConfirm, currentConfirm);
  React.useEffect(() => confirmHostMounted(), []);
  if (!request) return null;
  return <ConfirmDialog key={request.id} open title={request.title} description={request.description} confirmLabel={request.confirmLabel}
    cancelLabel={request.cancelLabel} danger={request.danger} onConfirm={() => answerConfirm(true)} onCancel={() => answerConfirm(false)}
    fallbackFocus={() => document.getElementById("workspace-main") ?? document.querySelector("main")} />;
}
