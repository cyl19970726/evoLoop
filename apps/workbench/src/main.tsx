import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import "./workbench.css";
import "./editorial.css";
import "./reading-pages.css";
import "./team-pages.css";
import "./completion.css";
import "./task-production.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
