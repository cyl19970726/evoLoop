// Component sample page (#/ui): every @evoloop/ui component in its states, on fake data, in light and dark.
// It is the only visual reference for components; docs do not carry component screenshots.
import * as React from "react";
import { Bell, Copy, MoreHorizontal, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import {
  AgentAvatar, Badge, Button, CollapsibleRow, CountDot, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState, Field,
  HoverCard, HoverCardContent, HoverCardTrigger, IconButton, Input, ListRow, LoadingState, Logo, Notice, PersonAvatar, RefreshingIndicator, Sheet,
  SheetContent, SheetDescription, SheetTitle, SheetTrigger, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Tooltip, TooltipContent,
  TooltipProvider, TooltipTrigger, UnknownState, systemLooks, type StatusTone,
  AgentMessage, Composer, LiveStatusLine, Mention, MessageBubble, NestedActivity, QuestionCard, QueuedMessages, TodoList, ToolSummary, TurnSummary,
  type ComposerAgent, type ComposerAttachment, type ComposerCommand, type QueuedMessage,
} from "@evoloop/ui";
import { sampleAgent, sampleAgents, sampleCommands, sampleInbox, samplePerson, sampleTasks, sampleTodos, type SampleAgent } from "../../shared/fixtures";

type Theme = "light" | "dark";

function Avatar({ agent, size }: { agent: SampleAgent; size?: number }) {
  return <AgentAvatar seed={agent.id} roleSeed={agent.roleId} look={agent.system ? systemLooks[agent.system] : undefined} size={size} />;
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-background p-6 shadow-lg">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="m-0 text-heading font-semibold leading-[1.3]">{title}</h2>
        {note && <span className="text-label text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)] md:items-center">
      <span className="text-label text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const tones: { tone: StatusTone; label: string; detail?: string }[] = [
  { tone: "progress", label: "进行中" }, { tone: "waiting", label: "待验收" }, { tone: "blocked", label: "受阻", detail: "依据待复核" },
  { tone: "done", label: "已完成" }, { tone: "idle", label: "待办" }, { tone: "unknown", label: "状态未核对" }, { tone: "history", label: "历史承接" },
];

function ConversationSample() {
  const dev = sampleAgent("agent-dev-1")!;
  const arch = sampleAgent("agent-arch-1")!;
  const review = sampleAgent("agent-review")!;
  const [draft, setDraft] = React.useState("");
  const [answer, setAnswer] = React.useState<string | undefined>(undefined);
  const [queue, setQueue] = React.useState<QueuedMessage[]>([{ id: "q-1", text: "窄屏下速览改成从底部升起" }]);
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([{ id: "task-1", label: "任务 · 右栏信息核对", kind: "task" }]);
  const [running, setRunning] = React.useState(true);
  const agents: ComposerAgent[] = sampleAgents
    .filter(agent => agent.id !== dev.id && agent.system !== "review")
    .map(agent => ({ id: agent.id, name: agent.name, state: agent.state, delivery: agent.tone === "idle" ? "now" : "queued", system: agent.system === "leader", avatar: <Avatar agent={agent} size={28} /> }));
  const commands: ComposerCommand[] = sampleCommands.map(command => ({ ...command }));

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-[18px]">
      <span className="self-center text-caption text-muted-foreground">今天 14:52</span>
      <MessageBubble>先把时间线接上 Claude 运行时，子智能体的内容要能缩进显示。</MessageBubble>
      <AgentMessage><p>好的。我先看适配器现在记录了哪些条目，再决定合同里的父子字段怎么加。</p></AgentMessage>
      <ToolSummary summary="执行了 5 个指令、读了 3 个文件" steps={[
        { text: "packages/adapter-claude-agent-sdk/src/history.ts", code: true, meta: "读取" },
        { text: "npm test -- timeline", code: true, meta: "12 秒" },
        { text: "npx tsc -p packages/contracts", code: true, meta: "类型错误 2 处", failed: true },
      ]} />
      <NestedActivity avatar={<Avatar agent={review} size={18} />} summary="子智能体 · 代码审查 · 执行了 2 个指令">
        <AgentMessage><p>原有记录没有保留父子关系，子消息在读取时被丢弃。</p></AgentMessage>
      </NestedActivity>
      <AgentMessage><p>审查发现原有记录没有保留父子关系。我会在合同里加 <code>parentEntryId</code>，再补上 Claude 的历史读取。</p></AgentMessage>
      <QuestionCard
        question="子智能体的内容默认怎样显示？"
        options={[{ key: "A", label: "折叠成一行，点开再看" }, { key: "B", label: "展开显示前三条" }, { key: "C", label: "全部展开" }]}
        note="只有项目负责人能回答 · 今天 18:00 前有效"
        answer={answer}
        onSubmit={setAnswer}
      />
      <MessageBubble footer={<><Avatar agent={arch} size={16} /><span>已转给架构 · 对方空闲，已送达</span></>}>
        <Mention name="架构" /> 右栏的数据结构是否需要改合同，请你看一下
      </MessageBubble>
      <TurnSummary produced="改了 3 个文件" delivered="合同草案第 1 版" next="下一步等架构回复" />
      {running && <LiveStatusLine avatar={<Avatar agent={dev} size={20} />} text="正在运行单元测试" elapsed="1 分 04 秒" />}
      <div className="flex flex-col gap-2.5 pt-2">
        <TodoList items={sampleTodos.map(todo => ({ ...todo }))} />
        <QueuedMessages items={queue} onCancel={id => setQueue(items => items.filter(item => item.id !== id))} onEdit={id => { const item = queue.find(entry => entry.id === id); if (item) { setDraft(item.text); setQueue(items => items.filter(entry => entry.id !== id)); } }} />
        <Composer
          value={draft}
          onChange={setDraft}
          running={running}
          onStop={() => setRunning(false)}
          onSend={text => { if (running) setQueue(items => [...items, { id: `q-${Date.now()}`, text }]); setDraft(""); }}
          attachments={attachments}
          onRemoveAttachment={id => setAttachments(items => items.filter(item => item.id !== id))}
          onAttach={() => setAttachments(items => items.some(item => item.id === "doc-1") ? items : [...items, { id: "doc-1", label: "文档 · 对账规则", kind: "document" }])}
          commands={commands}
          skillScope="功能开发可用"
          onPickCommand={command => { if (command.kind === "skill") setAttachments(items => [...items.filter(item => item.kind !== "skill"), { id: command.id, label: `技能 · ${command.name}`, kind: "skill" }]); if (command.id === "command-stop") setRunning(false); }}
          agents={agents}
          meta={<><span>Claude Opus</span><span>上下文 42%</span><span>{queue.length} 条排队</span><span>{running ? "回车排到下一轮 · Esc 停止" : "回车发送"}</span></>}
        />
      </div>
    </div>
  );
}

export default function UiSamplesPage() {
  const [theme, setTheme] = React.useState<Theme>("light");
  const [selected, setSelected] = React.useState(sampleTasks[0].id);

  React.useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = theme;
    return () => { if (previous) root.dataset.theme = previous; else delete root.dataset.theme; };
  }, [theme]);

  return (
    <TooltipProvider delayDuration={300}>
      <div data-ui="" className="min-h-screen bg-sunken font-sans text-small leading-[1.55] text-foreground">
        <header className="sticky top-0 z-10 flex items-center gap-3 bg-sunken/90 px-4 py-3 backdrop-blur md:px-8">
          <Logo size={32} />
          <div className="flex min-w-0 flex-col">
            <span className="text-small font-semibold">组件样例</span>
            <span className="truncate text-caption text-muted-foreground">@evoloop/ui · 假数据 · 不连接任何项目</span>
          </div>
          <Tabs value={theme} onValueChange={value => setTheme(value as Theme)} className="ml-auto">
            <TabsList aria-label="配色">
              <TabsTrigger value="light">浅色</TabsTrigger>
              <TabsTrigger value="dark">深色</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button asChild variant="ghost" size="compact"><a href="#/">返回工作台</a></Button>
        </header>

        <main className="mx-auto flex max-w-[1080px] flex-col gap-4 px-4 pb-16 pt-2 md:px-8">
          <Section title="按钮与输入" note="主按钮每屏最多一个；按钮是胶囊形">
            <Row label="按钮">
              <Button variant="primary">通过验收</Button>
              <Button>退回返工</Button>
              <Button variant="ghost">稍后</Button>
              <Button variant="danger">撤回交付</Button>
              <Button disabled>不可用</Button>
            </Row>
            <Row label="紧凑与图标">
              <Button size="compact" variant="primary"><Plus aria-hidden="true" />新建任务</Button>
              <Button size="compact">表格视图</Button>
              <IconButton label="设置" icon={<Settings aria-hidden="true" />} />
              <IconButton label="通知" icon={<Bell aria-hidden="true" />} compact />
              <Tooltip>
                <TooltipTrigger asChild><IconButton label="复制链接" icon={<Copy aria-hidden="true" />} /></TooltipTrigger>
                <TooltipContent>复制链接</TooltipContent>
              </Tooltip>
            </Row>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="任务名称" hint="写成一件可验收的事，例如“右栏信息核对”。">{props => <Input placeholder="任务名称" {...props} />}</Field>
              <Field label="完成条件" error="还没写完成条件：写清做到什么程度算完。">{props => <Input defaultValue="" placeholder="完成条件" {...props} />}</Field>
              <Field label="你用过之后的结论" hint="会记为一条使用记录，智能体返工时会读到。" className="md:col-span-2">{props => <Textarea placeholder="说说实际用起来怎样" {...props} />}</Field>
            </div>
          </Section>

          <Section title="状态" note="颜色加图标加文字，不靠颜色单独表达">
            <Row label="状态标签">{tones.map(item => <StatusTag key={item.label} {...item} />)}</Row>
            <Row label="计数">
              <Badge>8</Badge><Badge>12</Badge>
              <span className="inline-flex items-center gap-1.5 text-label text-text-secondary">待我处理 <CountDot count={5} /></span>
              <RefreshingIndicator />
            </Row>
            <div className="grid gap-3 md:grid-cols-3">
              <Notice title="对账规则有新版">任务固定在第 1 版，当前是第 2 版。</Notice>
              <Notice tone="waiting" title="等你回答" action={<Button size="compact">去回答</Button>}>需求在等你决定排序方式。</Notice>
              <Notice tone="error" title="发送失败">消息没有送达，草稿还在输入框里。</Notice>
            </div>
          </Section>

          <Section title="空、加载、失败与未知" note="四种情况分开说，每种都写原因和下一步">
            <div className="grid gap-3 md:grid-cols-2">
              <EmptyState title="这一轮还没有任务" reason="需求总图已经写好，但还没有拆出任务。" action={<Button size="compact" variant="primary">从总图拆任务</Button>} />
              <div className="rounded-lg bg-muted px-5 py-4"><LoadingState /></div>
              <ErrorState title="任务列表没有读到" happened="协调服务没有响应。" previousContentKept next="稍后会自动重读，也可以现在重试。" diagnostics="GET /api/projects/…/tasks → 503" action={<Button size="compact">重试</Button>} />
              <UnknownState title="交付结果未知" lastKnown="11:20 已提交交付第 1 版" reason="这台机器离线，无法确认是否已送达" owner="项目负责人" howToCheck="机器上线后按原操作查回，不会重新提交" />
            </div>
          </Section>

          <Section title="列表、折叠与页签" note="列表行用选中底色区分，不做成卡片">
            <div className="grid gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
              <div className="flex flex-col gap-0.5 rounded-lg bg-sunken p-2">
                {sampleTasks.map(task => {
                  const owner = sampleAgent(task.ownerId);
                  return (
                    <ListRow
                      key={task.id}
                      selected={task.id === selected}
                      onSelect={() => setSelected(task.id)}
                      leading={owner ? <Avatar agent={owner} size={28} /> : undefined}
                      title={task.title}
                      meta={`优先级${task.priority} · ${task.due}`}
                      trailing={<StatusTag tone={task.tone} label={task.state} />}
                    />
                  );
                })}
              </div>
              <div className="flex flex-col gap-4">
                <Tabs defaultValue="info">
                  <TabsList aria-label="右栏页签">
                    <TabsTrigger value="info">任务信息</TabsTrigger>
                    <TabsTrigger value="doc">对账规则</TabsTrigger>
                  </TabsList>
                  <TabsContent value="info" className="pt-3 text-text-secondary">承接智能体、状态与对账阶段、关联文档、交付与使用。</TabsContent>
                  <TabsContent value="doc" className="pt-3 text-text-secondary">文档速览：所看版本与当前版的关系写在顶部。</TabsContent>
                </Tabs>
                <CollapsibleRow summary="执行了 5 个指令、读了 3 个文件，1 次失败">
                  <div className="flex flex-col gap-1.5 rounded-md bg-muted px-3.5 py-2.5 text-label text-text-secondary">
                    <span>读取 adapter.ts</span><span>运行 npm test -- timeline</span><span className="text-destructive">运行类型检查 · 失败</span>
                  </div>
                </CollapsibleRow>
                <div className="flex flex-wrap items-center gap-2">
                  <HoverCard>
                    <HoverCardTrigger asChild><a href="#/ui" className="text-primary underline-offset-4 hover:underline">对账规则</a></HoverCardTrigger>
                    <HoverCardContent>
                      <p className="m-0 font-semibold">对账规则</p>
                      <p className="m-0 mt-1 text-label text-text-secondary">文档 · 第 2 版 · 统筹 今天 14:51 修改 · 3 个任务在引用</p>
                    </HoverCardContent>
                  </HoverCard>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><IconButton label="更多操作" icon={<MoreHorizontal aria-hidden="true" />} compact /></DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>右栏信息核对</DropdownMenuLabel>
                      <DropdownMenuItem><Pencil aria-hidden="true" />改完成条件</DropdownMenuItem>
                      <DropdownMenuItem><Copy aria-hidden="true" />复制链接</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger><Trash2 aria-hidden="true" />取消任务</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Dialog>
                    <DialogTrigger asChild><Button size="compact" variant="danger">取消任务</Button></DialogTrigger>
                    <DialogContent>
                      <DialogTitle>取消“右栏信息核对”？</DialogTitle>
                      <DialogDescription>功能开发会停止这项任务，已交付的内容保留为历史。取消后可以重新打开。</DialogDescription>
                      <DialogFooter>
                        <DialogClose asChild><Button>先不取消</Button></DialogClose>
                        <DialogClose asChild><Button variant="danger">取消任务</Button></DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  <Sheet>
                    <SheetTrigger asChild><Button size="compact">底部速览</Button></SheetTrigger>
                    <SheetContent side="bottom" aria-describedby={undefined}>
                      <SheetTitle>对账规则</SheetTitle>
                      <SheetDescription>任务固定第 1 版 · 当前第 2 版</SheetDescription>
                      <p className="m-0 text-body leading-[1.8]">一、每项工作写清下一责任。二、运行结束不等于已验收。</p>
                    </SheetContent>
                  </Sheet>
                  <Sheet>
                    <SheetTrigger asChild><Button size="compact">右侧抽屉</Button></SheetTrigger>
                    <SheetContent side="right">
                      <SheetTitle>任务信息</SheetTitle>
                      <SheetDescription>窄屏时右栏以抽屉打开，Esc 关闭并回到触发位置。</SheetDescription>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>
            </div>
          </Section>

          <Section title="对话流与输入框" note="在输入框里打 / 或 @ 试试；运行中发送会排队">
            <ConversationSample />
          </Section>

          <Section title="头像与标志" note="底色跟职责走，发型和配饰跟智能体走">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {sampleAgents.map(agent => (
                <div key={agent.id} className="flex flex-col items-center gap-2 rounded-lg bg-muted px-3 py-4">
                  <Avatar agent={agent} size={64} />
                  <span className="font-medium">{agent.name}</span>
                  <span className="flex items-center gap-1.5"><Avatar agent={agent} size={30} /><Avatar agent={agent} size={20} /></span>
                  <StatusTag tone={agent.tone} label={agent.state} />
                </div>
              ))}
            </div>
            <Row label="账号与标志">
              <PersonAvatar name={samplePerson.name} />
              <span className="flex flex-col"><span className="font-medium">{samplePerson.name}</span><span className="text-caption text-muted-foreground">{samplePerson.role}</span></span>
              <Logo size={48} label="evoLoop" />
              <Logo size={24} />
              <Logo size={16} />
            </Row>
            <Row label="待我处理">
              <div className="flex w-full max-w-[420px] flex-col gap-0.5">
                {sampleInbox.map(item => {
                  const from = sampleAgent(item.fromId);
                  return <ListRow key={item.id} leading={from ? <Avatar agent={from} size={28} /> : undefined} title={item.title} meta={`${item.kind} · ${from?.name ?? "未知"}`} trailing={item.when} />;
                })}
              </div>
            </Row>
          </Section>
        </main>
      </div>
    </TooltipProvider>
  );
}
