// Path URLs for the workbench. The tree names every address the app answers; pages are still chosen by the
// section parsed in App (so visited pages stay mounted) until the new shell turns them into layout routes.
import { Outlet, createRootRoute, createRoute, createRouter, lazyRouteComponent, useRouterState, type ErrorComponentProps } from "@tanstack/react-router";
import { appHistory } from "../shared/navigation";
import { App } from "./App";
import { errorPage } from "./PageBoundary";
import { projectPaths } from "./routePaths";

function RootLayout() {
  const samples = useRouterState({ select: state => state.location.pathname === "/ui" });
  return samples ? <Outlet /> : <App />;
}

/** A page that throws while rendering: say so in the interface language and offer a reload, keeping the address. */
function PageError({ error }: ErrorComponentProps) {
  return <main data-ui="" className={errorPage.root} role="alert">
    <h1 className={errorPage.title}>页面出错了</h1>
    <p className={errorPage.lede}>这一页在显示时遇到错误，已停止渲染。刷新会重新读取当前地址；未提交的草稿可能丢失。</p>
    <details><summary className={errorPage.summary}>错误信息</summary><pre className={errorPage.detail}>{error instanceof Error ? error.message : String(error)}</pre></details>
    <button type="button" className={errorPage.button} onClick={() => window.location.reload()}>刷新页面</button>
  </main>;
}

const rootRoute = createRootRoute({ component: RootLayout, errorComponent: PageError, notFoundComponent: () => null });
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
