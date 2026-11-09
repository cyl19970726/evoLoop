import { DomainError } from "@evoloop/contracts/ports";
import { providerOfOwner, type NativeChildDiagnosticRecord as NativeChildDiagnostic, type RuntimeBinding, type RuntimeCapabilities, type RuntimeModelList,
  type RuntimeProvider, type RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import type { ManagedRuntime } from "./runner.js";

/** Binding-scoped optional methods: present when any runtime has them, unsupported for a binding whose runtime lacks them. */
const routedOptional = ["compactThread", "observeCompaction", "readThreadName", "setThreadName", "readWorkPage", "readWorkspaceHistory",
  "archiveThread", "isThreadArchived", "startConversationTurn", "qualifyConversationThread", "activateExecutionProfile",
  "inspectExecutionProfileActivation", "steerTurn"] as const;

/**
 * One coordinator driving several native runtimes at once. Each Session is driven by the runtime it was
 * reserved for: creation routes by the spec's provider, everything else by the binding's owner. Codex
 * connection-level inputs (native user input, workspace updates) come from the Codex runtime only.
 *
 * The lifecycle is shared: the composite is ready only while every runtime is ready, so losing the Codex
 * connection pauses Claude Sessions too until the coordinator recovers.
 */
export class ProviderRoutedRuntime implements ManagedRuntime {
  readonly compactThread?: NonNullable<ManagedRuntime["compactThread"]>;
  readonly observeCompaction?: NonNullable<ManagedRuntime["observeCompaction"]>;
  readonly readThreadName?: NonNullable<ManagedRuntime["readThreadName"]>;
  readonly setThreadName?: NonNullable<ManagedRuntime["setThreadName"]>;
  readonly readWorkPage?: NonNullable<ManagedRuntime["readWorkPage"]>;
  readonly readWorkspaceHistory?: NonNullable<ManagedRuntime["readWorkspaceHistory"]>;
  readonly archiveThread?: NonNullable<ManagedRuntime["archiveThread"]>;
  readonly isThreadArchived?: NonNullable<ManagedRuntime["isThreadArchived"]>;
  readonly startConversationTurn?: NonNullable<ManagedRuntime["startConversationTurn"]>;
  readonly qualifyConversationThread?: NonNullable<ManagedRuntime["qualifyConversationThread"]>;
  readonly activateExecutionProfile?: NonNullable<ManagedRuntime["activateExecutionProfile"]>;
  readonly inspectExecutionProfileActivation?: NonNullable<ManagedRuntime["inspectExecutionProfileActivation"]>;
  /** Codex mid-Turn input used by direct input; not part of the runner's runtime type. */
  readonly steerTurn?: (binding: RuntimeBinding, expectedTurnId: string, input: string, inputId: string) => Promise<{ turnId: string; itemId: string | null }>;
  readonly nativeInputConnectionId?: NonNullable<ManagedRuntime["nativeInputConnectionId"]>;
  readonly onNativeInput?: NonNullable<ManagedRuntime["onNativeInput"]>;
  readonly hasPendingInput?: NonNullable<ManagedRuntime["hasPendingInput"]>;
  readonly respondToInput?: NonNullable<ManagedRuntime["respondToInput"]>;
  readonly onWorkspaceUpdate?: NonNullable<ManagedRuntime["onWorkspaceUpdate"]>;

  constructor(private readonly children: ReadonlyMap<RuntimeProvider, ManagedRuntime>, private readonly defaultProvider: RuntimeProvider) {
    if (!children.size || !children.has(defaultProvider)) throw new Error("The default runtime must be one of the routed runtimes");
    const self = this as unknown as Record<string, unknown>;
    for (const name of routedOptional) {
      const methodOf = (child: ManagedRuntime) => (child as unknown as Record<string, unknown>)[name] as ((...args: unknown[]) => unknown) | undefined;
      if (![...children.values()].some(child => typeof methodOf(child) === "function")) continue;
      self[name] = (binding: RuntimeBinding, ...rest: unknown[]) => {
        const child = this.forBinding(binding);
        const method = methodOf(child);
        if (typeof method !== "function") throw new DomainError("CAPABILITY_UNAVAILABLE", `${this.providerOf(binding)} 运行时不支持此操作（${name}）`);
        return method.call(child, binding, ...rest);
      };
    }
    // Native user input and workspace updates belong to the one Codex connection.
    const codex = children.get("codex");
    if (codex) {
      for (const name of ["nativeInputConnectionId", "onNativeInput", "hasPendingInput", "respondToInput", "onWorkspaceUpdate"] as const) {
        const method = codex[name] as ((...args: unknown[]) => unknown) | undefined;
        if (typeof method === "function") self[name] = (...args: unknown[]) => method.apply(codex, args);
      }
    }
  }

  providers(): RuntimeProvider[] { return [...this.children.keys()]; }
  /** The runtime adapter for one provider; unavailable when this coordinator does not drive it. */
  forProvider(provider: RuntimeProvider): ManagedRuntime {
    const child = this.children.get(provider);
    if (!child) throw new DomainError("RUNTIME_PROVIDER_UNAVAILABLE", `本服务未启用 ${provider} 运行时`);
    return child;
  }
  forBinding(binding: Pick<RuntimeBinding, "owner">): ManagedRuntime { return this.forProvider(this.providerOf(binding)); }
  private providerOf(binding: Pick<RuntimeBinding, "owner">): RuntimeProvider {
    const provider = providerOfOwner(binding.owner);
    if (!provider) throw new DomainError("RUNTIME_OWNER_UNKNOWN", "binding owner is not a runtime this service knows");
    return provider;
  }
  private all(): ManagedRuntime[] { return [...this.children.values()]; }

  /** The default runtime's declaration; per-provider declarations come from `forProvider(p).capabilities()`. */
  capabilities(): RuntimeCapabilities {
    const declared = this.forProvider(this.defaultProvider).capabilities?.();
    if (!declared) throw new Error("Routed runtimes must declare capabilities");
    return declared;
  }
  listModels(): Promise<RuntimeModelList> { return this.listModelsFor(this.defaultProvider); }
  async listModelsFor(provider: RuntimeProvider): Promise<RuntimeModelList> {
    const child = this.forProvider(provider);
    if (!child.listModels) throw new DomainError("CAPABILITY_UNAVAILABLE", `${provider} 运行时不提供模型列表`);
    return child.listModels();
  }

  create(spec: RuntimeSessionSpec) { return this.forProvider(spec.provider ?? "codex").create(spec); }
  resume(binding: RuntimeBinding, spec: RuntimeSessionSpec) { return this.forBinding(binding).resume(binding, spec); }
  inspect(binding: RuntimeBinding) { return this.forBinding(binding).inspect(binding); }
  listTurns(binding: RuntimeBinding, cursor?: string) { return this.forBinding(binding).listTurns(binding, cursor); }
  listItems(binding: RuntimeBinding, turnId: string, cursor?: string) { return this.forBinding(binding).listItems(binding, turnId, cursor); }
  startTurn(...args: Parameters<ManagedRuntime["startTurn"]>) { return this.forBinding(args[0]).startTurn(...args); }
  interruptTurn(binding: RuntimeBinding, turnId: string) { return this.forBinding(binding).interruptTurn(binding, turnId); }
  registerBinding(binding: RuntimeBinding) { return this.forBinding(binding).registerBinding(binding); }
  hasFreshStartProof(binding: RuntimeBinding): boolean { return this.forBinding(binding).hasFreshStartProof?.(binding) ?? false; }

  async open(): Promise<void> {
    const opened: ManagedRuntime[] = [];
    try { for (const child of this.all()) { await child.open(); opened.push(child); } }
    catch (error) {
      await Promise.allSettled(opened.map(child => child.close()));
      throw error;
    }
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(this.all().map(child => child.close()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  isReady(): boolean { return this.all().every(child => child.isReady()); }
  private subscribeAll(subscribe: (child: ManagedRuntime) => (() => void) | undefined): () => void {
    const unsubscribers = this.all().map(subscribe).filter((value): value is () => void => !!value);
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }
  onDisconnect(listener: (reason: string) => void) { return this.subscribeAll(child => child.onDisconnect(listener)); }
  onEvent(listener: Parameters<ManagedRuntime["onEvent"]>[0]) { return this.subscribeAll(child => child.onEvent(listener)); }
  onApprovalRequest(listener: Parameters<ManagedRuntime["onApprovalRequest"]>[0]) { return this.subscribeAll(child => child.onApprovalRequest(listener)); }
  listChildDiagnostics(): NativeChildDiagnostic[] { return this.all().flatMap(child => child.listChildDiagnostics?.() ?? []); }
  onChildDiagnostic(listener: (diagnostic: NativeChildDiagnostic) => void | Promise<void>) {
    return this.subscribeAll(child => child.onChildDiagnostic?.(listener));
  }
  async flushChildDiagnostics(): Promise<void> { await Promise.all(this.all().map(child => child.flushChildDiagnostics?.())); }
}

/** Provider-aware view over a runner's runtime: a routed composite, or one runtime whose capabilities name its provider. */
export function runtimeProvidersOf(runtime: ManagedRuntime): RuntimeProvider[] {
  return runtime instanceof ProviderRoutedRuntime ? runtime.providers() : [runtime.capabilities?.()?.provider ?? "codex"];
}
export function runtimeForBinding(runtime: ManagedRuntime, binding: Pick<RuntimeBinding, "owner">): ManagedRuntime {
  return runtime instanceof ProviderRoutedRuntime ? runtime.forBinding(binding) : runtime;
}
export function runtimeForProvider(runtime: ManagedRuntime, provider: RuntimeProvider): ManagedRuntime | null {
  if (runtime instanceof ProviderRoutedRuntime) return runtime.providers().includes(provider) ? runtime.forProvider(provider) : null;
  return (runtime.capabilities?.()?.provider ?? "codex") === provider ? runtime : null;
}
