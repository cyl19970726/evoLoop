// Path URLs for the workbench. The tree names every address the app answers; pages are still chosen by the
// section parsed in App (so visited pages stay mounted) until the new shell turns them into layout routes.
import { Outlet, createRootRoute, createRoute, createRouter, lazyRouteComponent, useRouterState } from "@tanstack/react-router";
import { appHistory } from "../shared/navigation";
import { App } from "./App";
import { projectPaths } from "./routePaths";

function RootLayout() {
  const samples = useRouterState({ select: state => state.location.pathname === "/ui" });
  return samples ? <Outlet /> : <App />;
}

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: () => null });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
const samplesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/ui",
  component: lazyRouteComponent(() => import("./ui-samples/UiSamplesPage")) });
const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: "/p/$projectId" });

const projectChildren = projectPaths.map(path => createRoute({ getParentRoute: () => projectRoute, path }));

const routeTree = rootRoute.addChildren([homeRoute, samplesRoute, projectRoute.addChildren(projectChildren)]);

export const router = createRouter({
  routeTree,
  history: appHistory(),
  // Pages keep their own scroll position (see WorkspacePages); the router must not reset it on every address change.
  scrollRestoration: () => false,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
