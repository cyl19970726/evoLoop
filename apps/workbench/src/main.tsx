import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { router } from "./app/router";
import { queryClient } from "./app/queryClient";
import { installLinkNavigation, redirectLegacyHash } from "./shared/navigation";
import { installLegacyTeamRedirect } from "./shared/routes";
import "./main.css";
import faviconUrl from "@evoloop/ui/logo-small.svg";

// The favicon comes from @evoloop/ui so the logo has one source; Vite resolves this import in dev and build alike.
document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", faviconUrl);

// Old `#/p/…` links (bookmarks, documents, other tools) land on the matching path before anything renders.
redirectLegacyHash();
// Old team addresses (`/runtime?view=…`, `/runtime?session=owned:…`) likewise, now and on every later navigation.
installLegacyTeamRedirect();
installLinkNavigation();

createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>
</React.StrictMode>);
