// Whether the page around this point is the one on screen. Visited pages stay mounted (hidden) to keep their state;
// only the visible page may fill shared areas (the inner rail's object list, the right column). The app's page
// container provides it. Kept apart from the panel code so the first load does not pull in its UI.
import { createContext } from "react";

export const PageActive = createContext(true);
