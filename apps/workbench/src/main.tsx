import React, { Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "@evoloop/ui/tokens.css";
import "./legacy-tokens.css";
import "./style.css";
import "./workbench.css";
import "./editorial.css";
import "./reading-pages.css";
import "./team-pages.css";
import "./completion.css";
import "./task-production.css";
import "@evoloop/ui/scope.css";
import faviconUrl from "@evoloop/ui/logo-small.svg";

// The favicon comes from @evoloop/ui so the logo has one source; Vite resolves this import in dev and build alike.
document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", faviconUrl);

// #/ui is the component sample page: fake data only, no login, loaded on demand.
const UiSamplesPage = lazy(() => import("./app/ui-samples/UiSamplesPage"));
const isSamples = () => window.location.hash === "#/ui" || window.location.hash.startsWith("#/ui?");

function Root() {
  const [samples, setSamples] = useState(isSamples);
  useEffect(() => {
    const onHash = () => setSamples(isSamples());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return samples ? <Suspense fallback={null}><UiSamplesPage /></Suspense> : <App />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Root /></React.StrictMode>);
