import { DomainError } from "@evoloop/contracts/ports";
import { providerOfOwner, type NativeChildDiagnosticRecord as NativeChildDiagnostic, type RuntimeBinding, type RuntimeCapabilities, type RuntimeModelList,
  type RuntimeProvider, type RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import type { ManagedRuntime } from "./runner.js";

/** Binding-scoped optional methods: present when any runtime has them, unsupported for a binding whose runtime lacks them. */
const routedOptional = ["compactThread", "observeCompaction", "readThreadName", "setThreadName", "readWorkPage", "readWorkspaceHistory",
  "archiveThread", "isThreadArchived", "startConversationTurn", "qualifyConversationThread", "activateExecutionProfile",
  "inspectExecutionProfileActivation", "steerTurn", "qualifyConnectorReceiver", "startConnectorTurn"] as const;
type Subscription = { subscribe: (child: ManagedRuntime) => (() => void) | undefined; codexOnly: boolean;
  active: Map<RuntimeProvider, () => void> };

/**
 * One coordinator driving several native runtimes at once. Each Session is driven by the runtime it was
 * reserved for: creation routes by the spec's provider, everything else by the binding's owner. Codex
 * connection-level inputs (native user input, workspace updates) come from the Codex runtime only.
 *
 * The composite is ready only while every runtime is ready, so losing the Codex connection pauses the pump for
 * Claude Sessions too until the coordinator recovers. Recovery replaces only the runtimes that are not ready
 * (`closeUnready`, `rebuild`, `openProviders`): a Claude Turn running in its own process is not stopped because
 * Codex reconnects.
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
  /** Codex Connector receiver Turns; not part of the runner's runtime type. */
  readonly qualifyConnectorReceiver?: (binding: RuntimeBinding, connectorBindingId: string) => Promise<{ available: boolean; reason: string; fingerprint: string | null }>;
  readonly startConnectorTurn?: (binding: RuntimeBinding, input: string, operationId: string, connectorBindingId: string,
    fingerprint: string) => Promise<import("@evoloop/contracts/runtime").RuntimeTurn>;
  readonly nativeInputConnectionId?: NonNullable<ManagedRuntime["nativeInputConnectionId"]>;
  readonly onNativeInput?: NonNullable<ManagedRuntime["onNativeInput"]>;
  readonly hasPendingInput?: NonNullable<ManagedRuntime["hasPendingInput"]>;
  readonly respondToInput?: NonNullable<ManagedRuntime["respondToInput"]>;
  readonly onWorkspaceUpdate?: NonNullable<ManagedRuntime["onWorkspaceUpdate"]>;

  private readonly children: Map<RuntimeProvider, ManagedRuntime>;
  private readonly subscriptions = new Set<Subscription>();

  /** `replace` builds a fresh runtime for one provider when recovery replaces it; without it every child is rebuilt by the caller. */
  constructor(children: ReadonlyMap<RuntimeProvider, ManagedRuntime>, private readonly defaultProvider: RuntimeProvider,
    private readonly replace?: (provider: RuntimeProvider) => ManagedRuntime) {
    if (!children.size || !children.has(defaultProvider)) throw new Error("The default runtime must be one of the routed runtimes");
    this.children = new Map(children);
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
    // Native user input and workspace updates belong to the one Codex connection, whichever instance holds it now.
    const codex = children.get("codex");
    if (codex) {
      for (const name of ["nativeInputConnectionId", "hasPendingInput", "respondToInput"] as const) {
        if (typeof codex[name] !== "function") continue;
        self[name] = (...args: unknown[]) => {
          const current = this.children.get("codex")!;
          return (current[name] as (...values: unknown[]) => unknown).apply(current, args);
        };
      }
      for (const name of ["onNativeInput", "onWorkspaceUpdate"] as const) {
        if (typeof codex[name] !== "function") continue;
        self[name] = (listener: unknown) => this.track(child => (child[name] as ((value: unknown) => () => void) | undefined)?.call(child, listener), true);
      }
    }
  }

  /** Providers whose runtime is not ready now; recovery replaces exactly these. */
  unreadyProviders(): RuntimeProvider[] { return [...this.children].filter(([, child]) => !child.isReady()).map(([provider]) => provider); }
  /** Whether recovery can replace one runtime without touching the others. */
  canReplace(): boolean { return !!this.replace; }

  /**
   * Recovery, step 1: closes the runtimes that are not ready while every listener can still observe their exit.
   * Runtimes that are still ready, and the Turns they are running, are left untouched.
   */
  async closeUnready(): Promise<RuntimeProvider[]> {
    if (!this.replace) throw new Error("This routed runtime cannot replace a single provider");
    const providers = this.unreadyProviders();
    const results = await Promise.allSettled(providers.map(provider => this.children.get(provider)!.close()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    return providers;
  }
  /** Recovery, step 2: a new instance for each closed provider, with every current listener moved over to it. */
  rebuild(providers: readonly RuntimeProvider[]): void {
    if (!this.replace) throw new Error("This routed runtime cannot replace a single provider");
    for (const provider of providers) {
      this.forProvider(provider);
      for (const subscription of this.subscriptions) { subscription.active.get(provider)?.(); subscription.active.delete(provider); }
      const next = this.replace(provider);
      this.children.set(provider, next);
      for (const subscription of this.subscriptions) this.attach(subscription, provider, next);
    }
  }
  /** Recovery, step 3: opens the rebuilt runtimes. */
  async openProviders(providers: readonly RuntimeProvider[]): Promise<void> {
    for (const provider of providers) await this.forProvider(provider).open();
  }

  private attach(subscription: Subscription, provider: RuntimeProvider, child: ManagedRuntime): void {
    if (subscription.codexOnly && provider !== "codex") return;
    const unsubscribe = subscription.subscribe(child);
    if (unsubscribe) subscription.active.set(provider, unsubscribe);
  }
  /** Subscribes on every current runtime and on any runtime that later replaces one of them. */
  private track(subscribe: Subscription["subscribe"], codexOnly = false): () => void {
    const subscription: Subscription = { subscribe, codexOnly, active: new Map() };
    this.subscriptions.add(subscription);
    for (const [provider, child] of this.children) this.attach(subscription, provider, child);
    return () => {
      this.subscriptions.delete(subscription);
      for (const unsubscribe of subscription.active.values()) unsubscribe();
      subscription.active.clear();
    };
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
  /** The actual provider and pinned version serving this binding, not the coordinator default. */
  capabilitiesFor(binding: Pick<RuntimeBinding, "owner">): RuntimeCapabilities {
    const declared = this.forBinding(binding).capabilities?.();
    if (!declared) throw new DomainError("CAPABILITY_UNAVAILABLE", "Session runtime does not declare capabilities");
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
  allowedReasoningEfforts(binding: RuntimeBinding): readonly string[] | null { return this.forBinding(binding).allowedReasoningEfforts?.(binding) ?? null; }
  appliesEffortWithNextTurn(binding: RuntimeBinding): boolean { return this.forBinding(binding).appliesEffortWithNextTurn?.(binding) ?? false; }
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
  onDisconnect(listener: (reason: string) => void) { return this.track(child => child.onDisconnect(listener)); }
  onEvent(listener: Parameters<ManagedRuntime["onEvent"]>[0]) { return this.track(child => child.onEvent(listener)); }
  onApprovalRequest(listener: Parameters<ManagedRuntime["onApprovalRequest"]>[0]) { return this.track(child => child.onApprovalRequest(listener)); }
  listChildDiagnostics(): NativeChildDiagnostic[] { return this.all().flatMap(child => child.listChildDiagnostics?.() ?? []); }
  onChildDiagnostic(listener: (diagnostic: NativeChildDiagnostic) => void | Promise<void>) {
    return this.track(child => child.onChildDiagnostic?.(listener));
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
