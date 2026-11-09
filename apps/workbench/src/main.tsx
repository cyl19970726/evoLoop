import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@evoloop/ui/tokens.css";
import "./legacy-tokens.css";
import "./style.css";
import "./workbench.css";
import "./editorial.css";
import "./reading-pages.css";
import "./team-pages.css";
import "./completion.css";
import "./task-production.css";
import faviconUrl from "@evoloop/ui/logo-small.svg";

// The favicon comes from @evoloop/ui so the logo has one source; Vite resolves this import in dev and build alike.
document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute("href", faviconUrl);

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
