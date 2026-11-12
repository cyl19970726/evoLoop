// Page chunks that cannot be fetched. After a release the old chunk files are gone, and a tab opened before it (the token lives in page
// memory, so such tabs stay open) fails to load any page it had not visited. React.lazy remembers the first failure for the life of the
// component, so a retry has to build a new lazy component; `resetChunks` makes every page chunk do that on its next render.
import { createElement, lazy, type ComponentProps, type ComponentType, type LazyExoticComponent } from "react";

let generation = 0;
/** The next render of every page chunk requests its file again instead of replaying the first failure. */
export function resetChunks(): void { generation += 1; }

/** What a browser reports when a dynamically imported module cannot be fetched (names differ by engine). */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|ChunkLoadError/i.test(text);
}

/** A page component loaded on first render, whose load is attempted again after `resetChunks`. */
export function lazyChunk<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K]> {
  let current: { generation: number; component: LazyExoticComponent<M[K]> } | null = null;
  const get = () => {
    if (!current || current.generation !== generation)
      current = { generation, component: lazy(async () => ({ default: (await load())[name] })) as LazyExoticComponent<M[K]> };
    return current.component;
  };
  const Chunk = (props: ComponentProps<M[K]>) => createElement(get() as ComponentType<any>, props);
  return Chunk as unknown as LazyExoticComponent<M[K]>;
}
