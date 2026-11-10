// Shows the questions askConfirm() queues (shared/confirm.ts), one at a time, in @evoloop/ui's ConfirmDialog.
// App mounts it after login; it loads on demand so the login page stays free of the design system's scripts.
import * as React from "react";
import { ConfirmDialog } from "@evoloop/ui";
import { answerConfirm, currentConfirm, subscribeConfirm } from "../confirm";

export function ConfirmHost() {
  const request = React.useSyncExternalStore(subscribeConfirm, currentConfirm, currentConfirm);
  if (!request) return null;
  return <ConfirmDialog key={request.id} open title={request.title} description={request.description} confirmLabel={request.confirmLabel}
    cancelLabel={request.cancelLabel} danger={request.danger} onConfirm={() => answerConfirm(true)} onCancel={() => answerConfirm(false)} />;
}
